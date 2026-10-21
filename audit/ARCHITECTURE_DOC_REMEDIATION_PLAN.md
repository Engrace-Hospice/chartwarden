# Architecture Corpus — Remediation Plan




Companion to [`ARCHITECTURE_DOC_CONSISTENCY_AUDIT_2026-08-13.md`](./ARCHITECTURE_DOC_CONSISTENCY_AUDIT_2026-08-13.md)
(the findings). This document is the **work plan**: discrete, ordered, verifiable items.

Each item states the defect, the exact fix, and how to prove it's done. Effort: **S** ≈ under an
hour · **M** ≈ a few hours · **L** ≈ a day or more.

**Reserved identifiers for this work:** next ADR is **ADR-0036**; next migration is **0191**.

---

## Priority map

| Track                                  | Items        | Why this order                                                              |
| -------------------------------------- | ------------ | --------------------------------------------------------------------------- |
| **P0 — Code defects**           | AC-01…AC-05 | Found while auditing; security/ops-relevant and independent of any doc work |
| **P1 — Runbook errors**         | AD-01…AD-07 | These docs would cause wrong action if followed during an incident          |
| **P2 — Record the divergences** | AR-01…AR-06 | Converts "the doc is wrong" into "the doc records what we chose"            |
| **P3 — Correct the corpus**     | AD-08…AD-16 | Bulk doc correction, cheapest once P2 fixes the framing                     |
| **P4 — Structural gate**        | AG-01…AG-02 | Prevents recurrence; do last so the gate lands on a clean corpus            |

P0 and P1 are independent and can run in parallel. P4 must land **after** P3 or it fails on day one.

---

## P0 — Code defects

These are not documentation problems. They were surfaced by cross-checking doc claims against code,
and each was hand-verified.

### AC-01 — Break-glass cosign accepts the invoker as their own cosigner · **S** · security

**Defect.** `apps/backend/src/modules/03-authorization/routes/authz-routes.ts:361-371` and
`break-glass-store.ts:92-101`: `cosign(eventId, byUserId)` writes `status:"active", cosignedBy: byUserId` with no comparison against the event's invoker. Neither the route nor the store checks
distinctness, and there is no DB constraint. Cosign and revoke share the `breakglass.cosign`
permission.

When a tenant sets `breakglass_cosign_required = true`, two-person authorization *is* the control —
and a user holding `breakglass.cosign` can approve their own emergency PHI access. Every other
two-person control in the repo enforces distinctness (M34 shred, M30 CAP + PIP, M28 FHIR, M35
refund, M21 comfort-kit).

**Fix.** Reject `cosignedBy == invokedBy` in the store's `cosign` (throw a typed conflict, mirroring
`assertM34ShredPreflight`'s shape), and add a DB CHECK so the invariant survives a future caller.
Audit the refusal — a self-cosign attempt is a signal worth keeping.

**Verify.** New live test: invoker self-cosign → 409; distinct cosigner → 200. Confirm the CHECK
rejects a direct SQL update.

---

### AC-02 — Two M24 tables enable RLS without FORCE · **S** · security

**Defect.** `0175_billing_m24_state_plan_code_rls.sql:20` and
`0180_billing_m24_state_rate_schedule_rls.sql:5` issue `ENABLE ROW LEVEL SECURITY` with no `FORCE`.
Both catalog sweeps (`0118`, `0159`) predate them; no later migration covers either table (last
FORCE migration is `0185`). Table owners are therefore RLS-exempt on both — precisely the gap `0118`
was written to close.

**Fix.** Migration `0191`: re-run `0159`'s idempotent catalog sweep verbatim. It is already written
as a catalog-driven re-sweep rather than a hand-maintained list, explicitly so it can be re-run —
copy the `DO $$ … relrowsecurity AND NOT relforcerowsecurity … $$` block. No new logic to design.

**Verify.**

```sql
SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity AND NOT c.relforcerowsecurity;
```

must return zero rows. Add the M24 tables to a live cross-tenant RLS suite.

---

### AC-03 — Tighten-only step-up policy is enforced at neither layer · **M**

**Defect.** Two halves of one control, both absent:

1. `apps/backend/src/modules/02-identity/policy/step-up-resolver.ts:45` states
   "`trg_tenant_step_up_tighten_only` trigger is the at-rest guard; this is its app-layer twin."
   That trigger appears in **zero** of the 191 migrations. The comment asserts a guard that was
   never built.
2. M3's `step_up_recent` predicate (`03-authorization/abac-predicates.ts:40-55`) passes the platform
   floor straight through and never calls the tenant resolver — so the app-layer twin isn't on the
   live path either.

**Fix.** This needs a decision, not just code. Either:

- **(a)** Write the trigger (matching the tighten-only pattern used for EVV geofence / bereavement
  cadence) *and* wire the resolver into `step_up_recent`; or
- **(b)** Accept platform-floor-only step-up, delete the misleading comment, and record why.

(a) is consistent with the rest of the codebase. Whichever is chosen, the comment must stop
describing a nonexistent object.

**Verify.** If (a): live test proving a tenant row that *loosens* the floor is rejected at write
time and ignored at evaluation time.

---

### AC-04 — Readiness probe cannot detect a MinIO outage · **S** · ops

**Defect.** `apps/backend/src/bootstrap/readiness-probe.ts:110` hard-codes `minio: "ok"`, while
`routes/health.ts:33-39` advertises `minio` as a checked dependency. `/ready` therefore stays green
through a total object-storage outage — and DR/BCP §6.3's storage-failover detection reads exactly
this signal.

**Fix.** Either implement a real check (HEAD on the configured bucket, inside the existing 3 s
per-check timeout) or remove `minio` from the advertised set. A dependency listed but not checked is
worse than one not listed.

**Verify.** Point `MINIO_*` at a dead endpoint; `/ready` must return 503.

---

### AC-05 — Public signup endpoint has no rate limit; no account lockout exists · **M** · security

**Defect.** `SECURITY_HARDENING §22.1` specifies 5/IP/hour on `POST /api/v1/public/signup-intents`.
The port defaults to `createAllowAllRateLimiter()`
(`34-saas-tenant-platform/routes/public/signup-intents.ts:79-86`) and the composition root never
injects a real limiter — unlimited in practice. Separately, §5.3.1 specifies per-username lockout
and captcha after 3 failures; there is **no account lockout anywhere** and `captcha`/`turnstile`
have zero hits repo-wide. The global limiter is a fixed 60 s window, not the documented 10 min.

**Fix.** Two independent decisions:

- Inject a real limiter at the composition root for the public signup route (the port already exists).
- Decide whether per-username lockout is in scope. If yes, implement. If no, correct §5.3.1 — see
  **AD-13**, and do not leave the doc claiming a control that doesn't exist.

**Verify.** 6th signup POST from one IP within an hour → 429.

---

## P1 — Runbook and DR errors

A runbook with a wrong command is worse than no runbook. Fix these outright — none has an
aspirational reading.

### AD-01 — Wrong ports throughout both ops docs · **S**

Health and deploy commands use `4181` / `4191` (DR §6.1 L424, §6.3 L547; Runbook §4.2 L194/L200,
§13.3 L1687). Real: API `PORT ?? 3000`, worker `WORKER_PORT ?? 3001`; `Dockerfile` `EXPOSE 3000 3001`.
`4181` appears nowhere in the repo. **Fix:** global replace, then grep the corpus for `418[0-9]` to
confirm none remain.

### AD-02 — Nine tenant/DSAR/legal-hold commands point at a nonexistent directory · **M**

`packages/db/scripts/` does not exist. Affected: Runbook §4.6 L335, §11.1 L1312/L1318/L1331/L1339,
§11.2 L1373, §11.3 L1392, §11.4 L1419, §11.5 L1436, §11.6 L1451. The entire §11 Tenant Operations
chapter is non-executable. **Fix:** map each to its real equivalent (several are HTTP routes on
M34/M4, not scripts); where no equivalent exists, mark the procedure `NOT IMPLEMENTED` rather than
leaving a command that fails.

### AD-03 — Shred crash-recovery command does not exist · **S** · highest-stakes

DR §14A.2 L1372 cites `packages/saas-tenant-platform/scripts/resume-shred.ts`. That path does not
exist. This is the recovery procedure for an interrupted **irreversible DEK destruction** — the
single most consequential operation in the platform. **Fix:** point at the real recovery path, or
state plainly that no automated resume exists and describe the manual procedure.

### AD-04 — DR forensic SQL is invalid against the real schema · **S**

DR §14A.3 L1385-1390 selects `occurred_at`, `actor_membership_id`, `patient_id` from `audit_event`;
real columns are `created_at`, `actor_user_id`, and there is no `patient_id`. The `actor_kind`
values queried (`platform_ops_via_support_session`, `break_glass`) are not enum members. The query
errors immediately. Runbook §12.3 uses the correct columns — **the two docs disagree with each
other.** **Fix:** replace with §12.3's working form; run it against a live DB before committing.

### AD-05 — `/version` deploy check can never pass · **S**

Runbook §4.3 L245 expects `/version` to return the new SHA. `health.ts:41` reads `APP_VERSION` /
`GIT_SHA` / `BUILD_TIME`; the `Dockerfile` sets none and `deploy.yml` injects none, so it always
returns `{"version":"dev","gitSha":"unknown"}`. **Fix:** inject the values at build time in
`deploy.yml` (preferred — the check is genuinely useful), or delete the step.

### AD-06 — Partition inventory: 5 of 9 rows wrong · **S**

Runbook §5.2.1 L418-428. `encounter`, `message`, `feature_flag_evaluation` are not partitioned at
all; `encounter_note` does not exist; `claim` is LIST(`provider_entity_id`) only with no RANGE
sub-partition; `hope_assessment` is RANGE **`target_date`**, not `created_at`. Correct: `audit_event`,
`extraction_job`. Also §5.2.2's rotation snippet cites `packages/db/src/jobs/partition-rotation.ts`
(nonexistent) and calls `create_message_partition` / `create_outbox_partition` (neither exists;
`outbox_event` isn't partitioned). **Fix:** regenerate the table from `pg_partitioned_table` and fix
the snippet.

### AD-07 — Supply-chain verification steps reference absent tooling · **S**

Runbook §4.1 L159-161 and §4.2 claim green e2e + SBOM in CI, cosign-signed images, and a `cosign verify` gate. `cosign`, `syft`, `trivy`, `grype` have zero hits repo-wide; `ci.yml` has no e2e job
(Playwright exists but is unwired) and no SBOM step; `ci.yml` builds no image (`deploy.yml` does);
the image is `ghcr.io/<owner>/wardenx`, not `ghcr.io/wardenx/backend`. **Fix:** delete the steps or
mark `STATUS: TARGET`. Do not leave a verification step operators believe is protecting them.

---

## P2 — Record the divergences as ADRs

**This is the reframe that makes P3 cheap.** Most severity-B "drift" is not rot — the build
deliberately diverged, and no ADR was written. Each item below converts a false statement into a
recorded decision. Numbering from **ADR-0036**.

| ID              | ADR  | Decision to record                                                                                                                                                                                                                                                                                   | Effort |
| --------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **AR-01** | 0036 | **Frontend: react-router + Vite, not TanStack Start.** All three SPAs use Vite 6 + `react-router-dom` ^7; no `@tanstack/*` is installed. (Repo memory notes react-router v7 was a deliberate TASK-066 choice.)                                                                             | S      |
| **AR-02** | 0037 | **No realtime backbone.** Socket.IO is absent; `packages/messaging/src/realtime/*` are pure room-name builders that state they import no socket.io. ARCHITECTURE §25.13 currently prescribes it as *the* cross-module channel — the outbox is what actually carries cross-module events. | S      |
| **AR-03** | 0038 | **X12/cost-report processing is TypeScript, not Python sidecars.** Zero `.py` files, no `services/`, no `infra/`. `packages/x12-837-client`, `x12-835-client`, `cost-report` do this work; the fail-closed `X12_WORKER_NOT_WIRED` port fronts a sidecar that was never built.    | M      |
| **AR-04** | 0039 | **Envelope encryption is application-layer AES-256-GCM with HKDF per-tenant DEKs, not pgcrypto.** `pgcrypto` is installed but used only for `gen_random_uuid()` — zero `pgp_sym_encrypt`/`encrypt(` calls in 191 migrations. **Highest compliance weight of the six.**          | M      |
| **AR-05** | 0040 | **State machines are pure transition functions, not XState.** Not installed; multiple files say so explicitly (`saas-tenant-platform/src/onboarding/machine.ts:8-13`).                                                                                                                       | S      |
| **AR-06** | 0041 | **No `@fastify/*` plugins.** CSP/HSTS/CORS/rate-limiting are hand-written "with NO new npm dependency" (`bootstrap/plugins/security.ts:15`); OpenAPI is emitted offline by `scripts/openapi/emit.ts`; no multipart, no SSE.                                                              | S      |

Optionally fold AR-05/AR-06 into one "hand-rolled over dependency" ADR if that matches how the team
reasons about it.

---

## P3 — Correct the corpus

With P2 written, most of this becomes citation + framing rather than argument.

### AD-08 — Mark aspirational sections `STATUS: TARGET — NOT BUILT` · **M**

The repo already has this idiom: `ops/pgbackrest/*.template`, `Dockerfile`, `docker-compose.yml`,
and `deploy.yml` all carry "SCAFFOLD, NOT VALIDATED" headers. **Neither ops doc carries one, and
neither does ARCHITECTURE §12.** Apply it to: the DR VM fleet (Pangolin/PgBouncer/PBS/MinIO
cluster/PagerDuty/Grafana/Sentry), ARCHITECTURE §12 sidecars + §17 dev topology, §7's ~60-role
catalog (13 shipped), the realtime backbone, and SYSTEM_DESIGN's compose topology. These are
legitimate target state — harmful only because they read as present tense.

### AD-09 — Fix `ARCHITECTURE_25_15_FITNESS.md` · **S**

Documents `arch:fitness` as 4 gates; it is **20** (`ci.yml` already notes its own label went stale).
Checks 8 and 9 (Biome `require-explicit-authz` / `require-read-audit`) are listed "already in place"
but **do not exist** — `biome.json` has no custom rules and Biome 1.9.4 has no plugin API. Real
enforcers: the runtime `read-audit.ts` plugin and `check-abac-predicates.ts`. Also: lint is
`continue-on-error: true` in CI, contradicting the doc's pipeline; the manifest is authoritative for
all 40 modules (not "1–4") with **463** owned tables; `audit-fitness.ts` is wired to no script.
**Fix:** stop inlining the gate list — point at `package.json`, the same fix `ci.yml` already made.

### AD-10 — Fix ARCHITECTURE §20 dependency table · **S**

`architecture/module-manifest.ts:6` claims `dependsOn` is "verbatim from ARCHITECTURE §20 dep table."
It no longer is: M9/M10/M11 dropped M8 (the ADR-0007 seam inversion — recorded in the doc's own
changelog but never propagated to §20), plus M22→39 and M35→34 divergences with no cover. **Fix:**
regenerate §20 from the manifest and keep the manifest as source of truth, or drop the "verbatim"
claim. Two artifacts each claiming to mirror the other, disagreeing, is the worst of both.

### AD-11 — Fix ARCHITECTURE tech-stack and layout sections · **M**

Beyond the AR-01…AR-06 divergences: `apps/frontend` → `apps/web`; §9's `apps/backend/src/{routes, services}` and `packages/db/src/repos` don't exist (real layout is per-module vertical slices);
11 named dependencies aren't installed (OpenTelemetry, Sentry, MinIO client, react-pdf, Puppeteer,
Testcontainers, MSW, Recharts, iconsax, shadcn/ui, Stripe SDK, Anthropic SDK); idempotency is
Postgres, not Valkey; ~60 roles catalogued vs 13 shipped; `packages/rules-engine`, `apps/mobile` and
5 other paths don't exist; `packages/saas` → `packages/saas-tenant-platform`; 26 of 47 real packages
undocumented.

### AD-12 — Fix `CHARTWARDEN_INTEGRATIONS_v0_1.md` · **M**

15 of 33 adapter paths wrong (superseded by ADR-0028/0029, which post-date the doc by one day) —
eight of the cited packages were never created, and `packages/ai-platform/src/backends/anthropic.ts`
rebuts the doc by name. Wrong EVV vendor (doc: "OR-PTC DCI"; built: **Sandata**). **§11's entire
open-items table cites ADR numbers belonging to unrelated ADRs** — the real ones are 0019/0026/0028/
0029. `better-auth`, the only installed third-party SDK, has no inventory row (an INT-002 violation
by the doc's own rule).

**Add a wiring-status column.** The doc's most useful possible enhancement: essentially **no
integration is live**. There is no MAC transport at all (not "J6 only"); HETS 270/271, DoseSpot HTTP,
iQIES, web-push, local AI, terminology loaders and triage vendors are absent; SHP CAHPS is
transport-unwired (only `manual` needs none); M28 FHIR reads return hardcoded 404/empty-Bundle with
no data path, and bulk `$export` has no route or worker. The most-wired vendor surface is **inbound
Twilio/Postmark webhooks**; outbound email is a no-op in production. Real network `fetch` exists in
exactly **6** non-test files.

### AD-13 — Fix `CHARTWARDEN_SECURITY_HARDENING_v0_2.md` · **M**

- **§1.4 must carve out the rate limiter.** It states "fail closed… never default to allow on error"
  with no exception, but the limiter deliberately fails open on store outage. **The code is right** —
  it's an availability control, not an authorization gate — so document the exception rather than
  changing the code.
- **§6.5 service-to-service auth is fiction**: describes mTLS + short-lived signed tokens; actual is
  a static shared secret, no mTLS, no signature, no expiry, with the tenant taken from a
  **caller-supplied `x-internal-org-id` header**. Either correct §6.5 or treat the gap as a security
  backlog item — this one deserves an explicit decision.
- Rate-limit numbers (§5.3.1) — see **AC-05**.
- **Session timeouts are declared but never enforced**: `SESSION_POLICY.byClass` has no runtime
  reader; `betterAuth({session})` sets only `additionalFields` — no `expiresIn`/`updateAge`, no
  cookie config, no IP/UA binding.
- **§6.2's route example won't compile** — shows an inline predicate closure; the real API takes a
  registry-resolved name string.
- Header drift: HSTS 31536000 (doc: 63072000), `SameSite=Lax` (doc: `Strict`), no Origin/Referer
  check, `Permissions-Policy` documented but never set. §4.2 names pgcrypto (see AR-04). §22.2's DEK
  lifecycle reads as operational while `kekUnwrap` is a throwing stub.
- **§13.1's audit append-only claim needs its carve-out**: `0157:84` grants `SELECT, DELETE ON audit_event TO wardenx_destruction` — intentional and documented in-file for the partitioned
  crypto-erase adapter — but the integrity report inspects only `wardenx_app` and cannot detect drift
  on that role.

### AD-14 — Fix `CHARTWARDEN_SYSTEM_DESIGN_v0.3.md` · **S**

Same TanStack / Socket.IO / sidecar / Valkey-idempotency drift as AD-11, plus: dev topology cites
`docker compose -f infra/docker/dev.compose.yaml` with valkey/minio/mailpit/mlflow (real: a bare
`docker run` of Postgres on port **5440**); ports 4180/4181 (real: 5173 / 3000); lefthook (real:
`.githooks`); five §12.6 `bun` commands that don't exist; header cites architecture v0.10.

### AD-15 — Fix `CHARTWARDEN_AI_GOVERNANCE_v0.2.md` · **M**

Best-maintained doc in the corpus — inventory (18 capabilities), lifecycle FSM and backend list are
all **current**. But:

- **`ai.full` is never mentioned in 1756 lines.** It is the outermost gate, it is OFF platform-wide,
  and it is why no model is dispatched today and all 10 M32 inference seams resolve to deny-stubs.
  Adding it is the single highest-value edit to this document.
- **The kill switch is described as a feature flag.** It is an `ai_kill_switch_state` row with
  `platformRow.active OR tenantRow.active` semantics; no `ai.*_kill` flag is seeded anywhere — and
  the capability catalog the doc points at says in capitals that killing is not a flag flip.
- **§4.4's 14-section template describes none of the 18 real docs** (all carry 5 headings), and
  `arch:ai-governance` enforces the 5, not the 14. Align template to reality or extend the gate.
- §16.1's `ai.*` event names can never be outbox names (the `mN.` prefix is gate-enforced); real
  events are `m32.*`. Undocumented: the 8-gate invocation order and why it's safety-critical, the
  four deliberately-unbound ports, the DB-trigger immutability substrate, SEV-1 **auto-demotion**,
  and that R18 hallucination filing currently 503s on an unbound cipher.

### AD-16 — Resolve cross-document conflicts and mechanical rot · **M**

- **RTO/RPO, 4× disagreement.** `SYSTEM_DESIGN:1384` states a blanket **4 hr / 15 min**; `DR_BCP:134`
  sets Tier 1 at **1 hr / 5 min**. SYSTEM_DESIGN's own §10.1 row contradicts its §10.2 header.
  Pick one, put it in DR/BCP, have the other cite it. *(Note: no implementing mechanism exists for
  either — no replication, no WAL archiving. Consider recording the real target.)*
- **HOPE retention.** `OPS_RUNBOOK:425` says 6 years; ADR-0004 closed OPEN-021 moving it to **7**,
  and `ARCHITECTURE:2874` says 7. The runbook carries the pre-ADR value.
- **Filename vs. header version**: `CHARTWARDEN_ARCHITECTURE_v0_11.md` declares "v0.12";
  `CHARTWARDEN_INTEGRATIONS_v0_1.md` declares "v0.2". Two v0.2 files end with "End of … v0.1."
- **11 stale `Companion to:` citations** — every one but SECURITY_HARDENING's cites a superseded
  architecture version.
- **63 dead repo paths** (~78 occurrences). `infra/`, `docs/ops/`, `docs/policies/`, `docs/runbooks/`,
  `docs/dr-drills/`, `docs/feature-flags/`, `docs/architecture/vendor-escalation.md` don't exist.
- **Module-spec path convention wrong in three docs** — two variants cited, neither matching the real
  flat `docs/modules/CHARTWARDEN_MODULE_NN_*_SPEC_vX_Y.md`.
- **"Phase" is overloaded** — audit-remediation phases vs. product-launch phases, undisambiguated.
  Add a one-line glossary note; it is a live reader trap.

### AD-17 — Document the undocumented patterns · **L**

Term frequency across the 3067-line authoritative doc: `fitness` **0** · `module-manifest` **0** ·
`dependency-cruiser` **0** · `step-up` **0** · `read-audit` **0** · `withPlatformContext` **0** ·
`OpenAPI` **0** · `worker.ts` **0**.

Missing, roughly in order of how soon a new engineer hits them:

1. **The architecture-fitness kit** — manifest (40 modules / 130 codePaths / 463 tables),
   dependency-cruiser, ~18 gate scripts. The largest architectural apparatus in the repo, zero coverage.
2. **The opaque seam registry + deny-stub convention** — what keeps the module graph a DAG.
   Mentioned three times in passing, never as a pattern.
3. **Typed port + fail-closed vendor default** — the dominant integration idiom, enforced by
   `VENDOR_ADAPTERS` + a dependency-cruiser rule. This is the fact that most changes how §5/§12/§15/§16
   should be read.
4. **ABAC named-predicate registry**, fail-closed on unknown names, + `arch:abac-predicates`.
5. **PHI read-audit boot gate** — an undeclared PHI read route means the server *cannot boot*.
6. **Step-up re-authentication**; **break-glass** at the application level (§17 covers only
   infrastructure credentials); the **seven separation-of-duties controls**.
7. **`withPlatformContext()`** — the gated cross-tenant escape hatch (§25.10 covers only `withOrgContext`).
8. **Tighten-only tenant overrides** as a repo-wide invariant.
9. **The dedicated `worker.ts` process**; **OpenAPI emission + unenriched-route ratchet + typed client**;
   **fail-closed production env validation**; **the custom checksum-tracked SQL migration runner**
   (`drizzle.config.ts` states it is "the SOLE authoritative migrator" and the Drizzle journal is
   "INTENTIONALLY FROZEN").

> Much of this is already written in [`docs/APP_OVERVIEW.md`](../docs/APP_OVERVIEW.md) and
> [`docs/BUSINESS_LOGIC.md`](../docs/BUSINESS_LOGIC.md). Lift and adapt rather than rewriting — but
> the authoritative corpus needs to carry it, since that is what the authority rule binds to.

---

## P4 — Add the freshness gate

### AG-01 — `scripts/check-architecture-docs.ts` · **M**

**Rationale.** `arch:fitness` chains 20 gates; exactly one (`arch:ai-governance`) reads anything
under `docs/architecture/`. This repo gates its UI corpus, its plans, its design tokens, its ABAC
predicate names, its audit denylist and every generated report — but not the one body of prose the
authority rule makes binding. That is why it drifted freely for two months.

**Four rules, all pure string/filesystem checks with no false-positive risk:**

| Rule                                                          | Catches           | Would have caught                                                                               |
| ------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| Every repo path cited in an architecture doc must exist       | 63 dead paths     | The 15 wrong adapter paths*and* every dead runbook script, on the commit that introduced them |
| Filename version == header version                            | 2 mismatches      | ARCHITECTURE v0_11/v0.12, INTEGRATIONS v0_1/v0.2                                                |
| Every`Companion to: X vN.M` resolves to the on-disk version | 11 citations      | All of them                                                                                     |
| Every`ADR-NNNN` citation resolves to an existing ADR        | INTEGRATIONS §11 | The whole open-items table                                                                      |

Implementation notes: extract backticked path-like tokens and `ADR-\d{4}` references; allowlist
deliberate non-paths (e.g. `packages/foundation`, which `ARCHITECTURE_25_15_FITNESS.md` cites
*because it is banned*); follow the existing `--check` convention so it composes into `arch:fitness`.

**Sequencing: land this after P3.** On today's corpus it fails immediately with ~80 findings.

### AG-02 — Optional: per-doc verification stamp · **S**

Add `<!-- verified-against: <git-sha> · <date> -->` to each doc; warn (don't fail) past a staleness
threshold. Cheap, and it makes "when was this last checked against reality?" answerable — the
question this entire audit existed to answer.

---

## Suggested sequencing

1. **AC-01, AC-02** — small, security-relevant, no dependencies. Do first.
2. **AD-01…AD-07** — the runbook is dangerous while wrong; each is S/M and independent.
3. **AC-03, AC-04, AC-05** — need a decision each; batch them into one review.
4. **AR-01…AR-06** — write the ADRs. Unblocks the framing for all of P3.
5. **AD-08…AD-17** — corpus correction. AD-08 (status headers) first: it makes the rest smaller by
   moving whole sections out of "wrong" and into "declared target."
6. **AG-01, AG-02** — land the gate on a clean corpus.

**Fastest meaningful slice** if capacity is tight: AC-01 + AC-02 + AD-01 + AD-03 + AD-04. That
removes the self-cosign hole, closes the RLS gap, and makes the incident-response procedures
executable — roughly half a day, and it retires the findings most likely to hurt.
