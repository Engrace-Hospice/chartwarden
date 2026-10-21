# ChartWarden — Operations Runbook

**Document ID:** CHARTWARDEN_OPS_RUNBOOK
**Status:** v0.1
**Owner:** Fabrice V. Adjam (Engineering)
**Companion to:** CHARTWARDEN_ARCHITECTURE v0.12 (file `CHARTWARDEN_ARCHITECTURE_v0_11.md`), CHARTWARDEN_SYSTEM_DESIGN v0.3, CHARTWARDEN_DR_BCP v0.1
**Review cadence:** Quarterly minimum; updated continuously as procedures evolve
**Last reviewed:** 2026-06-08

**Scope distinction:** This document covers **routine operations** and **degraded-but-not-broken** scenarios. Catastrophic scenarios (DB primary loss, ransomware, regional disaster) are in CHARTWARDEN_DR_BCP. The dividing line: if it's a SEV-1 in DR_BCP §2.3, look in DR_BCP first; if it's SEV-2/3/4 or planned work, look here.

---

## 1. Purpose & Scope

### 1.1 What This Document Is

The Ops Runbook is the operator's daily reference. It contains:

- Step-by-step procedures for every routine operational task
- Concrete commands, not abstract guidance
- Decision trees for common degraded scenarios
- Schedules and cadences for recurring work
- Pre/post checklists for changes
- Tuning guidance for monitoring and alerting

It is written so that any qualified engineer can execute the procedures, not only the original author. This is a deliberate hedge against single-point-of-failure operator dependency.

### 1.2 What This Document Is Not

- **Architectural reference** — see CHARTWARDEN_ARCHITECTURE
- **Runtime design** — see CHARTWARDEN_SYSTEM_DESIGN
- **Catastrophic incident response** — see CHARTWARDEN_DR_BCP
- **Security threat model** — see CHARTWARDEN_SECURITY_HARDENING
- **Vendor contract details** — see CHARTWARDEN_INTEGRATIONS
- **Module implementation specs** — see `docs/modules/<NN-name>/SPEC.md`

### 1.3 Conventions

- Commands shown for production unless explicitly marked DEV
- VM names use the convention in CHARTWARDEN_SYSTEM_DESIGN §2.2 (`wardenx-app-01`, `wardenx-db-01`, etc.)
- "Operator" refers to the engineer executing the procedure
- "On-call" refers to whoever is currently designated to receive alerts
- All times are operator's local timezone unless explicitly UTC

---

## 2. Operational Governance

### 2.1 On-Call Model

| Phase | Primary | Secondary |
|---|---|---|
| Engrace-only (current) | Fabrice 24/7 | None (acknowledged SPOF; see DR_BCP §2.1) |
| 2-3 tenants | Fabrice 8 AM – 8 PM; contracted relief 8 PM – 8 AM | Cross-coverage with relief |
| 4+ tenants | Formal rotation, 2-engineer minimum | — |

### 2.2 On-Call Responsibilities

When on-call:

- Maintain a working laptop with VPN access reachable within 5 minutes
- Phone on-person, with PagerDuty (or equivalent) ringer-override configured
- Internet access (home + mobile hotspot fallback)
- Annual NDA-signed handoff log for off-week summaries

When going on-call (start of shift):

- Review the on-call dashboard for open incidents
- Read recent post-incident reviews if any in the past two weeks
- Note any scheduled maintenance windows in your shift
- Acknowledge handoff from outgoing on-call

When going off-call (end of shift):

- Update handoff log with: open incidents, watch items, customer commitments made, vendor escalations in progress

### 2.3 Maintenance Windows

| Window | Day/time | Used for |
|---|---|---|
| **Routine maintenance window** | Sunday 02:00 – 04:00 local | Non-disruptive deploys, certificate renewals, vacuum analyzes |
| **Major change window** | Sunday 02:00 – 06:00 local (scheduled in advance) | Schema migrations, infra changes, planned failover drills |
| **Emergency maintenance** | Anytime (rare) | Critical security patches, urgent bug fixes |

Maintenance windows announced to customers ≥ 7 days in advance via status page + email; emergency maintenance announced as soon as practicable.

---

## 3. Operational Cadences

### 3.1 Daily

| Time | Task | Owner |
|---|---|---|
| 08:00 | Review overnight alerts and dismiss noise | On-call |
| 08:30 | Check backup job status (pgBackRest, MinIO replication, PBS) — all green? | On-call |
| 09:00 | Review SEV-3 and SEV-4 incidents from prior 24 hr | On-call |
| 17:00 | End-of-day check — any open watch items? | On-call |
| Continuous | Respond to alerts | On-call |

### 3.2 Weekly

| Day | Task | Owner |
|---|---|---|
| Monday | Review prior week's incidents; categorize for trends | On-call |
| Monday | Patch review — any CVE patches needed in next deploy? | Engineering |
| Wednesday | Capacity check — VM resource utilization trend | On-call |
| Friday | Pre-weekend checklist — any deploys/changes scheduled? Defer if not necessary | On-call |
| Sunday 02:00 | Routine maintenance window (auto: PG full backup; vacuum; lifecycle policies) | Automated |

### 3.3 Monthly

| Date | Task | Owner |
|---|---|---|
| 1st | Monthly restore drill (DR_BCP §8.2) | On-call |
| 1st | Cost watch — Anthropic spend, Twilio spend, Postmark spend reviewed against budget | Engineering |
| 1st | Partition rotation verification — next 3 months of partitions exist for all partitioned tables | Engineering |
| 5th | Alert fatigue review — which alerts fired most often? Retune. | On-call |
| 10th | Tenant census report to compliance — active orgs, active CCNs, active users | Compliance |
| 15th | Dependency update review — Renovate PRs reviewed and merged | Engineering |
| 20th | Backup restoration verification — random sample of MinIO objects | On-call |
| 25th | Audit log review — sample of high-risk events (admin actions, PHI exports, RLS denials) | Compliance |
| End of month | Closeout — incident summary; SLO measurement | Engineering |

### 3.4 Quarterly

| Quarter month | Task | Owner |
|---|---|---|
| Q-month 1 | Failover drill (DR_BCP §8.3) | On-call |
| Q-month 1 | Access review — terminated users, role changes, dormant accounts | Compliance |
| Q-month 2 | Vendor BAA status review — renewals approaching, terms current | Compliance |
| Q-month 2 | Cost analysis — actual vs budget, variance review | Engineering |
| Q-month 3 | Pen test (when in place — Phase 2) | External vendor |
| Q-month 3 | Security patch backlog review | Engineering |

### 3.5 Annual

| Month | Task | Owner |
|---|---|---|
| January | HIPAA Security Risk Analysis (mandatory) | Compliance + contracted assessor |
| March | Annual full DR exercise (DR_BCP §8.4) | Engineering + contracted assistance |
| June | Insurance renewal — cyber, E&O, general liability | Operations |
| August | Policy review — every ChartWarden policy reviewed for currency | Compliance |
| October | Encryption key rotation (production data keys) | Engineering |
| December | Year-end audit log retention compliance verification | Compliance |
| Floating | SOC 2 audit (when sought — Phase 3) | External auditor |
| Floating | HITRUST audit (when sought — future) | External auditor |

---

## 4. Deployment Operations

### 4.1 Pre-Deploy Checklist

For every deploy, however small:

- [ ] Code merged to `main` (no direct deploys from branches)
- [ ] All CI checks green — what `ci.yml` **actually** runs: build, `arch:fitness` (read the gate chain from `package.json`, never from prose),
      unit/integration tests, the live-DB jobs (`rls-live`, `lifecycle-live`, the per-module
      matrix), and the `e2e` job (a real Chromium against a migrated + seeded full stack: 18
      critical-workflow specs and the 12 axe-core WCAG 2A/AA assertions that are the repo's only
      automated accessibility coverage outside the lint rules — 12 scans against 290 registered
      screens, so read that as a smoke test, not as coverage). **Lint is BLOCKING** (F-011/#33):
      `ci.yml` runs `bun run lint` as an ordinary step and `scripts/__tests__/lint-gate.test.ts`
      asserts it stays that way, so the check mark can be trusted. This bullet previously said
      `continue-on-error: true`; that was true until #33 and told operators to distrust the repo's
      main automated a11y control.
- [ ] SBOM produced — `deploy.yml`'s `release` job runs `syft` over each published image (SPDX JSON),
      uploads both as workflow artifacts (90-day retention) and attaches them to the images as cosign
      attestations. The attestation is the copy that matters: an SBOM that lives only in an Actions run
      expires with the run and cannot be fetched from the host running the image.
- [ ] Image vulnerability scan green — Trivy scans both images and **HIGH/CRITICAL fail the release**.
      The only way past is an entry in `.trivyignore.yaml`, which must carry a statement and an
      unexpired date within 90 days (`arch:vuln-allowlist`, in `arch:fitness`). There is no severity
      threshold to turn down.
- [ ] Container images signed with cosign — keyless (Fulcio/Rekor), over the **digest**, with the
      release job verifying its own signatures before the deploy job runs. `deploy.sh` verifies again on
      the VPS against a pinned workflow identity and pins `.env.production` to the verified digest.
      (F-040/#100.)
- [ ] Migration files reviewed (if present): forward-only? two-phase pattern if breaking?
- [ ] Feature flags: any new flags? Default values set? Documented in `docs/feature-flags/`? (**directory does not exist** — flags are currently documented only in the M34 admin surface and the seed)
- [ ] Customer-facing change? If so, customer communication drafted
- [ ] Maintenance window if needed (DB schema change, breaking API change)
- [ ] Status page maintenance announcement scheduled if needed
- [ ] Rollback plan documented in PR (every PR has a "How to roll this back" line)
- [ ] On-call awareness — operator briefed if not the same person

### 4.2 Standard Deploy Procedure (Blue-Green)

```bash
# 1. Pre-flight: verify CI artifacts
gh run list --workflow=ci.yml --status=success --limit=1
# Verify the SHA you intend to deploy

# 2. Verify image signature and SBOM (F-040/#100 — real, not aspirational)
#    The identity is the assertion: not "signed by someone with a key" but "built by THIS repo's
#    deploy.yml on this ref, per GitHub's OIDC issuer". A signature from any other workflow, repo,
#    branch or actor fails here — which is what makes this worth running while `main` still has no
#    branch protection (#16).
cosign verify ghcr.io/engrace-hospice/chartwarden:sha-<sha> \
  --certificate-identity \
    "https://github.com/Engrace-Hospice/wardenx/.github/workflows/deploy.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"

#    The SBOM travels with the image as an attestation:
cosign verify-attestation --type spdxjson ghcr.io/engrace-hospice/chartwarden:sha-<sha> \
  --certificate-identity \
    "https://github.com/Engrace-Hospice/wardenx/.github/workflows/deploy.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  | jq -r '.payload | @base64d | fromjson | .predicate.name'

#    `deploy.sh` does the same verification automatically and then pins `.env.production` to the
#    digest cosign returned, so the pull cannot resolve the tag to anything else. Run the above by
#    hand only when deploying outside the workflow, or when answering "what is actually running?".

# 3. Pull image to all app VMs (parallel; doesn't impact running traffic)
#    NOTE the real image name is ghcr.io/<repository_owner>/wardenx (deploy.yml's metadata-action),
#    NOT ghcr.io/wardenx/backend. Tags are `sha-<full-sha>` and `latest` on the default branch.
for vm in wardenx-app-01 wardenx-app-02; do
  ssh $vm "docker pull ghcr.io/<owner>/chartwarden:sha-<sha>" &
done
wait

# 4. Start new (green) containers alongside existing (blue) on each app VM
for vm in wardenx-app-01 wardenx-app-02; do
  ssh $vm "docker run -d \
    --name wardenx-backend-green \
    --network wardenx \
    --env-file /etc/wardenx/.env \
    -p 3000:3000 \
    ghcr.io/<owner>/chartwarden:sha-<sha>"
done

# 5. Wait for health on green
for vm in wardenx-app-01 wardenx-app-02; do
  until curl -sf https://$vm:3000/ready; do
    sleep 5
    echo "Waiting for green health on $vm"
  done
done

# 6. Add green to load balancer at 5% weight
ssh wardenx-edge-01 "/etc/wardenx/lb-cli weight green 5"
sleep 60
# Watch for error spike — if any, abort

# 7. Ramp: 5% → 25% → 50% → 100% over 5 minutes
for w in 25 50 100; do
  ssh wardenx-edge-01 "/etc/wardenx/lb-cli weight green $w"
  sleep 90
  # Watch for error spike
done

# 8. Cut blue to 0%
ssh wardenx-edge-01 "/etc/wardenx/lb-cli weight blue 0"

# 9. Verify no traffic going to blue
ssh wardenx-edge-01 "/etc/wardenx/lb-cli show"

# 10. Hold blue containers running for 1 hour (rollback window)
# After 1 hour with no rollback need:
for vm in wardenx-app-01 wardenx-app-02; do
  ssh $vm "docker stop wardenx-backend-blue && docker rm wardenx-backend-blue"
  ssh $vm "docker rename wardenx-backend-green wardenx-backend-blue"
done
# Now what was green is blue, ready for next deploy
```

**During deploy, watch:**

- Error rate on Grafana System Health dashboard
- p95 latency on backend
- Any new Sentry issues
- Customer-impacting alerts

### 4.3 Post-Deploy Verification

Within 15 minutes of deploy completion:

- [ ] `/health` and `/ready` returning 200 on all instances
- [ ] `/version` returns the expected new SHA — `curl -sf https://$vm:3000/version` should answer
      `{"version":"<ref>","gitSha":"<full sha>","buildTime":"…"}`. It reads `APP_VERSION` /
      `GIT_SHA` / `BUILD_TIME`, which `deploy.yml` injects as Docker build args (AD-05). A response
      of `{"version":"dev","gitSha":"unknown"}` means the image was built outside that pipeline —
      treat it as an unidentified build and do not promote it.
- [ ] Sample API endpoint succeeds (typically: list patients for Engrace) — manual curl
- [ ] No new Sentry issues at error rate > pre-deploy baseline
- [ ] Latency p95 within ± 20% of pre-deploy
- [ ] DB connections at normal level (no leak from new code)
- [ ] BullMQ workers connected, processing jobs

Within 1 hour:

- [ ] No customer reports of degradation
- [ ] Synthetic monitoring tests passing
- [ ] Audit log shows expected event volume
- [ ] Tenant-specific smoke (Engrace login + draft an encounter)

### 4.4 Rollback Procedure

Triggers for immediate rollback:

- Error rate > 5% sustained for > 5 minutes
- p99 latency > 2× baseline sustained for > 5 minutes
- New SEV-1 or SEV-2 incident traced to deploy
- Critical regression discovered by customer

```bash
# 1. Re-weight to previous version
ssh wardenx-edge-01 "/etc/wardenx/lb-cli weight blue 100; /etc/wardenx/lb-cli weight green 0"

# 2. Verify traffic shifted
ssh wardenx-edge-01 "/etc/wardenx/lb-cli show"

# 3. Status page update if customer-impacting
# "Rolled back recent deploy due to <description>. Investigating."

# 4. Stop green containers
for vm in wardenx-app-01 wardenx-app-02; do
  ssh $vm "docker stop wardenx-backend-green && docker rm wardenx-backend-green"
done

# 5. File rollback incident report
# Document: what broke, how detected, why CI didn't catch it
```

**Rollback time target: < 5 minutes from decision to fully rolled back.**

### 4.5 Hot-fix Deploy Procedure

For SEV-1 or SEV-2 bugs requiring immediate fix:

1. Branch from current production SHA: `git checkout -b hotfix/sev1-<short>`
2. Apply minimum change
3. Write or update a test that catches the bug
4. Push branch; trigger CI
5. If CI green, fast-track review by another engineer (or self-review with explicit acknowledgment) — production hotfix log entry mandatory
6. Merge to `main`
7. Deploy via standard procedure with **shorter ramp times** (5% → 50% → 100% over 3 minutes for established fixes)
8. Document hot-fix in incident retrospective

**If no second engineer available for review (solo dev case):** document the explicit self-review in the PR description: what the bug was, what test catches it, why this fix is correct, what could go wrong. This is a known weakness of solo-dev model and is reviewed in postmortems.

### 4.6 Database Migration Deploy

Migrations follow the **two-phase pattern** for breaking changes (Architecture v0.9 §25.12). Procedure:

#### Phase N — Additive migration

```bash
# 1. Review migration in PR
# Verify it's additive: adds columns/tables, no DROP, no RENAME of existing columns

# 2. Take pre-migration backup
ssh wardenx-db-01 "sudo -u postgres pgbackrest --stanza=chartwarden --type=incr --tag=pre-migration-<sha> backup"

# 3. Run migration against primary
# scripts/db/migrate.ts is the real production migration path (TASK-040E, OPS-016) — a
# checksum-tracked, idempotent runner over packages/db/migrations/*.sql. The per-deploy step
# uses --strict --schema-only (db:migrate:deploy): apply pending migrations and hard-fail on any
# checksum drift, without touching the chartwarden_app LOGIN/password/BYPASSRLS state (that's a
# one-time/rotation-only step — see the file header). Requires a superuser/owner connection: the
# migration files themselves CREATE EXTENSION / CREATE ROLE / own tables.
DATABASE_ADMIN_URL=postgres://chartwarden_admin:<pass>@wardenx-db-01/wardenx \
  bun run db:migrate:deploy

# 4. Verify migration applied
psql -h wardenx-db-01 -U postgres -d wardenx -c "SELECT * FROM _chartwarden_migration ORDER BY applied_at DESC LIMIT 5;"

# 5. Deploy new backend (with code that dual-writes old + new columns if applicable)

# 6. Let dual-write run for ≥ 1 week to surface any issues

# 7. Backfill script if needed
# NOT IMPLEMENTED — there is no `packages/db/scripts/` directory and no backfill harness.
# Write the backfill as a one-off under `scripts/db/` (where `migrate.ts` and `seed.ts` live) and
# run it with `bun run scripts/db/<name>.ts`; delete it once applied.
```

#### Phase N+1 — Switch reads

Deploy new backend that reads from new column/table; old column still written but no longer read.

#### Phase N+2 — Cleanup

```bash
# Migration removes old column/table
# Only run after confirming no code reads the old column
# Verify with grep + canary monitoring
```

### 4.7 Deploy Cadence Targets

| Type | Target cadence |
|---|---|
| Routine backend deploys | 1-3 per week during active development; daily acceptable |
| Frontend-only deploys | Anytime; usually daily |
| Schema migrations | At most weekly; coordinated with backend deploys |
| Infrastructure changes | Maintenance window only |
| Security patches | Within 72 hours of CVE publish for critical; 7 days for high; 30 days for medium |

---

## 5. Database Operations

### 5.1 Routine Maintenance

#### 5.1.1 Autovacuum Configuration

```ini
# postgresql.conf
autovacuum = on
autovacuum_max_workers = 4
autovacuum_naptime = 30s
autovacuum_vacuum_threshold = 50
autovacuum_vacuum_scale_factor = 0.1
autovacuum_analyze_threshold = 50
autovacuum_analyze_scale_factor = 0.05

# Aggressive on hot tables
ALTER TABLE audit_event SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE encounter SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE message SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE outbox_event SET (autovacuum_vacuum_scale_factor = 0.02);
```

#### 5.1.2 Weekly VACUUM Window

Sunday maintenance window:

```bash
# Targets: heavily-updated tables not adequately handled by autovacuum
ssh wardenx-db-01 "psql -U postgres -d wardenx <<EOF
VACUUM (ANALYZE, VERBOSE) outbox_event;
VACUUM (ANALYZE, VERBOSE) session;
VACUUM (ANALYZE, VERBOSE) idempotency_key;
EOF"
```

#### 5.1.3 Reindex Monthly

```bash
# Reindex bloated indexes during maintenance window
# Detect bloated indexes:
psql -U postgres -d wardenx -c "
SELECT schemaname, tablename, indexname,
       pg_size_pretty(pg_relation_size(indexrelid)) as size
FROM pg_stat_user_indexes
WHERE pg_relation_size(indexrelid) > 100*1024*1024  -- > 100MB
ORDER BY pg_relation_size(indexrelid) DESC;"

# Reindex specific index (concurrent to avoid lock):
psql -U postgres -d wardenx -c "REINDEX INDEX CONCURRENTLY audit_event_org_created_idx;"
```

### 5.2 Partition Management

#### 5.2.1 Partitioned Tables Inventory

> **Do not hand-maintain this list — derive it.** The table below was wrong in 5 of its 9 rows for
> most of this document's life: `encounter`, `message` and `feature_flag_evaluation` are not
> partitioned at all, `encounter_note` does not exist as a table, `claim` is LIST(`provider_entity_id`)
> with **no** RANGE sub-partition, and `hope_assessment` is RANGE **`target_date`**, not `created_at`.
> There are **59** partitioned tables, not 9. Get the live inventory from the catalog:
>
> ```sql
> SELECT c.relname AS table_name,
>        CASE p.partstrat WHEN 'r' THEN 'RANGE' WHEN 'l' THEN 'LIST' WHEN 'h' THEN 'HASH' END AS strategy,
>        (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
>           FROM unnest(p.partattrs) WITH ORDINALITY AS k(attnum, ord)
>           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum) AS partition_key
> FROM pg_partitioned_table p
> JOIN pg_class c     ON c.oid = p.partrelid
> JOIN pg_namespace n ON n.oid = c.relnamespace
> WHERE n.nspname = 'public'
> ORDER BY 1;
> ```

The operationally significant ones — the high-volume RANGE-by-time tables whose partitions must keep
being created (verified against the catalog 2026-08-14):

| Table | Partition by | Cadence | Retention |
|---|---|---|---|
| `audit_event` | RANGE `created_at` | Monthly | Per retention class (Architecture §24) |
| `evv_event` | RANGE `event_at` | Monthly | Per state retention |
| `administration_record` | RANGE `administered_at` | Monthly | 7 years |
| `medication_order` | RANGE `created_at` | Monthly | 7 years |
| `order_record` | RANGE `created_at` | Monthly | 7 years |
| `clinical_assessment` | RANGE `captured_at` | Monthly | 7 years |
| `hope_assessment` | RANGE `target_date` | Annually | 7 years (ADR-0004; **not** 6) |
| `visit` | RANGE `service_date` | Monthly | Per state retention |
| `document_access_log` | RANGE `accessed_at` | Monthly | Per retention class |
| `consent_eval_audit` | RANGE `evaluated_at` | Monthly | Per retention class |
| `extraction_job` | RANGE `queued_at` | Monthly | 30 days |
| `ai_invocation` | RANGE `invoked_at` | Monthly | Per AI-governance retention |

LIST-partitioned tables (`claim`, `medicaid_claim*`, the `cap_*` lines, `*_state_history`, the M34
`*_job_event` tables) partition by tenant or period key, not by time — their partitions are created
by the write path that first needs them, not by a time-based rotation.

#### 5.2.2 Partition Rotation Job

**Status: implemented** (F-033 / #93). `platform.partition_rotate` runs at 03:10 on the **1st, 8th and
15th** of each month and keeps the current + **3** following months of partitions created for every
time-RANGE-partitioned table. Three ticks rather than one because the work is a no-op once the window is
covered — a single monthly tick is one restart away from being no job at all.

**Correction — this section previously described the wrong failure.** It said a table with no partition
covering `now()` "rejects the INSERT outright … a write-path outage". That is true of a partitioned table
with no DEFAULT partition. **All 43 of these tables have one**, so what actually happens is quieter and
harder to recover from:

1. the write **succeeds**, landing in the DEFAULT partition — no error, no alert, nothing to notice;
2. the table keeps working, unpruned and progressively slower, for as long as nobody looks;
3. and the repair becomes impossible without downtime, because PostgreSQL refuses to create a partition
   overlapping rows already in DEFAULT:
   `updated partition constraint for default partition "…_default" would be violated by some row`.
   Fixing it then means moving rows out of DEFAULT under an `ACCESS EXCLUSIVE` lock on a table that has
   been absorbing writes for however long it took to notice.

That is why the alert to care about is not headroom, it is **DEFAULT occupancy**. Headroom is
self-healing; occupancy is not, and every hour of delay lengthens the eventual lock.

The old prose also said there were **55** creator functions. There are **53** — 40 date-keyed plus 13
uuid-keyed (the LIST-partitioned `cap_*` / `claim` / `medicaid_*` / `validation_*` / `rb_day` tables,
whose partitions the write path creates on demand). Neither number was ever authoritative: the count that
matters is what `pg_catalog` reports, which is what the job reads.

##### What runs

| | |
|---|---|
| Job id | `platform.partition_rotate` (allowlisted for `withPlatformContext`) |
| Queue | `platform.partition-rotate` |
| Cron | `10 3 1,8,15 * *` |
| SQL | `rotate_time_partitions(int)` · `time_partition_coverage()` (migration `0224_partition_rotation.sql`) |
| Code | `apps/backend/src/bootstrap/jobs/partition-rotation.ts` |
| Proof | `bun run test:partition-rotation:live` — runs in the `migration-gate` CI job |

Both SQL functions discover their work from `pg_catalog`; **nothing carries a table list.** A migration
that adds a time-RANGE partitioned table is picked up on the next tick with no code change — and if it
ships without a creator function, the live suite fails in CI (`no_creator`), which is the check
`arch:fitness` cannot make because it runs without a database.

##### Running it by hand

```sql
-- Rotate now (idempotent — every creator is CREATE TABLE IF NOT EXISTS, so re-running costs nothing).
SELECT * FROM rotate_time_partitions(3);
```

`status` is one of:

| `status` | Meaning | Action |
|---|---|---|
| `ok` | window already covered | none |
| `created` | partitions were added | none |
| `blocked` | the creator refused — almost always rows already in DEFAULT | **manual repair, see below** |
| `no_creator` | time-RANGE partitioned, nothing can extend it | needs a migration adding a `create_*_partition(date)` |

```sql
-- Health, worst first. `default_occupied` is the one that should page someone.
SELECT table_name, covered_through, months_headroom, default_occupied, has_creator
FROM time_partition_coverage()
ORDER BY default_occupied DESC, months_headroom ASC;
```

##### Alerts

Scraped from `/metrics` on every replica, read fresh on each scrape (`-1` = not measured):

| Metric | Fires when | Severity |
|---|---|---|
| `chartwarden_partition_default_occupied_tables` | `> 0` | **SEV-2** — not self-healing; repair cost grows with delay |
| `chartwarden_partition_missing_creator_tables` | `> 0` | SEV-3 — needs a migration |
| `chartwarden_partition_min_headroom_months` | `<= 1` for two consecutive ticks | SEV-3 — the rotation job is probably not running |

##### Recovering a `blocked` table

Rotation cannot fix this; it is a data-movement job. Take a maintenance window sized to the DEFAULT
partition, and in one transaction: detach DEFAULT, create the missing partitions, move the rows back from
the detached table into the parent (they route correctly now), then re-attach an empty DEFAULT. The
`ACCESS EXCLUSIVE` lock is held for the whole thing, so do this at the first opportunity rather than the
convenient one — the table is still accepting writes into DEFAULT while you wait.

#### 5.2.3 Manual Partition Operations

Detach an expired partition for archival:

```sql
-- Detach Jan 2026 audit partition (compliance class) for archival
ALTER TABLE audit_event DETACH PARTITION audit_event_2026_01;

-- Export to Parquet for cold storage
COPY audit_event_2026_01 TO '/tmp/audit_2026_01.parquet' WITH (FORMAT 'parquet');

-- Upload to MinIO cold storage
mc cp /tmp/audit_2026_01.parquet wardenx-primary/platform/cold-storage/audit/2026/

-- Drop the partition
DROP TABLE audit_event_2026_01;

-- Audit the destruction
INSERT INTO audit_event (event_type, resource_kind, ..., context)
VALUES ('audit.partition_archived', 'partition', ..., '{"partition": "audit_event_2026_01"}');
```

For partitions in `operational` retention class (1-year retention):

- Detach 13 months after creation
- Cold storage in MinIO `platform/cold-storage/<table>/<year>/<month>.parquet`
- Original partition dropped
- Restorable on-demand if needed for investigation

For `legal_hold` retention class:

- Never detach
- Skip in retention job

### 5.3 Connection Pool Management

#### 5.3.1 PgBouncer Configuration

```ini
# /etc/pgbouncer/pgbouncer.ini
[databases]
wardenx = host=wardenx-db-01 dbname=wardenx pool_mode=transaction

[pgbouncer]
listen_port = 6432
listen_addr = 0.0.0.0
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 200
default_pool_size = 50
reserve_pool_size = 5
reserve_pool_timeout = 3
server_idle_timeout = 600
server_lifetime = 3600
ignore_startup_parameters = extra_float_digits
```

#### 5.3.2 Connection Pool Monitoring

```bash
# Check pool status
psql -h wardenx-app-01 -p 6432 -U pgbouncer pgbouncer -c "SHOW POOLS;"

# Watch for: cl_waiting > 0 means connections queued (pool exhausted)
# If sustained: increase pool size or investigate connection leak

# Check active queries
psql -h wardenx-db-01 -U postgres -c "
SELECT pid, usename, application_name, state, query_start, query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY query_start ASC;
"
```

#### 5.3.3 Connection Leak Investigation

Symptoms: connection count growing over time without traffic increase; PgBouncer pool exhaustion alerts.

```bash
# 1. Identify long-running queries
psql -h wardenx-db-01 -U postgres -c "
SELECT pid, state, query_start, NOW() - query_start AS duration, application_name, query
FROM pg_stat_activity
WHERE state != 'idle' AND query_start < NOW() - INTERVAL '5 minutes'
ORDER BY duration DESC;
"

# 2. Identify idle-in-transaction (leaked connections)
psql -h wardenx-db-01 -U postgres -c "
SELECT pid, query_start, NOW() - query_start AS duration, application_name
FROM pg_stat_activity
WHERE state = 'idle in transaction' AND query_start < NOW() - INTERVAL '5 minutes';
"

# 3. If idle-in-transaction connections leaking, find the code path
# Cross-reference application_name with backend logs by correlation ID

# 4. Emergency: kill stuck connections
psql -h wardenx-db-01 -U postgres -c "SELECT pg_terminate_backend(<pid>);"

# 5. Long-term: fix the code path holding the transaction open
```

### 5.4 Slow Query Investigation

```bash
# Recent slow queries via pg_stat_statements
psql -h wardenx-db-01 -U postgres -d wardenx -c "
SELECT
  query,
  calls,
  total_exec_time / 1000 AS total_sec,
  mean_exec_time AS mean_ms,
  rows,
  100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0) AS cache_hit_pct
FROM pg_stat_statements
WHERE total_exec_time > 60000  -- > 1 minute cumulative
ORDER BY total_exec_time DESC
LIMIT 20;
"

# Reset stats periodically to get fresh view
# psql -c "SELECT pg_stat_statements_reset();"

# For a specific slow query, get the plan
psql -h wardenx-db-01 -U postgres -d wardenx -c "EXPLAIN (ANALYZE, BUFFERS) <query>;"
```

Common causes and fixes:

| Symptom | Likely cause | Fix |
|---|---|---|
| Sequential scan on large table | Missing index | Add B-tree index |
| Slow JSONB filter | Missing GIN index | Add GIN index on JSONB column |
| Slow text search | Missing trigram or vector index | Add `gin_trgm_ops` or HNSW |
| Slow window function | Suboptimal sort | Add covering index |
| Many rows joined unexpectedly | Missing WHERE on parent before join | Reorder query or add WHERE |
| Cold buffer cache after restart | Normal — let cache warm | If sustained, increase `shared_buffers` |

### 5.5 Replication Monitoring

```bash
# On primary: check replicas' lag
psql -h wardenx-db-01 -U postgres -c "
SELECT
  application_name,
  client_addr,
  state,
  pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_lag_bytes,
  EXTRACT(EPOCH FROM (NOW() - reply_time))::int AS reply_lag_seconds
FROM pg_stat_replication;
"

# On replica: check own lag
psql -h wardenx-db-02 -U postgres -c "
SELECT
  pg_is_in_recovery(),
  pg_last_wal_receive_lsn(),
  pg_last_wal_replay_lsn(),
  pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) AS apply_lag_bytes,
  EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp())) AS replay_lag_seconds;
"

# If lag growing without trending back to zero, investigate:
# - Heavy write spike on primary
# - Slow replica (disk I/O bound)
# - Network bottleneck
# - Replica running a long query that conflicts with WAL replay
```

### 5.6 DDL Changes

DDL changes (CREATE INDEX, ALTER TABLE, etc.) require special care:

- **CONCURRENTLY for index creation/drop** on populated tables to avoid blocking writes
- **Long-running ALTER TABLE** should be done in maintenance window with monitoring
- **Schema changes through migrations only** — never ad-hoc on production
- **Two-phase pattern for breaking changes** (§4.6)

```bash
# Safe index addition example
ssh wardenx-db-01 "psql -U postgres -d wardenx -c '
CREATE INDEX CONCURRENTLY IF NOT EXISTS encounter_status_org_idx
ON encounter (status, organization_id)
WHERE status IN (\"draft\", \"in_progress\");
'"

# Check progress on long-running CREATE INDEX
psql -U postgres -d wardenx -c "
SELECT phase, blocks_total, blocks_done, blocks_done::float / blocks_total AS pct
FROM pg_stat_progress_create_index;
"
```

---

## 6. Storage Operations (MinIO)

### 6.1 Bucket Health Monitoring

```bash
# Bucket inventory
mc admin info wardenx-primary

# Per-bucket size and object count
mc du wardenx-primary/tenants/<org>/

# Replication status
mc replicate status wardenx-primary/tenants

# Quota check
mc admin user info wardenx-primary <tenant-user>
```

### 6.2 Lifecycle Policy Verification

Each PHI bucket has a lifecycle policy. Verify monthly:

```bash
# Get lifecycle policy
mc ilm rule list wardenx-primary/tenants/<org>/intake

# Expected output should match:
# - Expire incomplete multipart after 7 days
# - Delete after 30 days
```

If discrepancy, restore policy from `infra/minio/policies/` in Git.

### 6.3 Object Lock Verification (Compliance Buckets)

```bash
# Verify object lock on claims bucket
mc retention info wardenx-primary/tenants/<org>/claims/
# Expected: COMPLIANCE mode with 7-year retention

# Object lock prevents deletion even by admin (compliance mode)
# Until retention period passes
```

### 6.4 Replication Health

```bash
# Replication status all buckets
for bucket in $(mc ls wardenx-primary | awk '{print $5}'); do
  echo "Bucket: $bucket"
  mc replicate status wardenx-primary/$bucket
done

# Lag check
mc replicate status wardenx-primary/tenants --json | jq '.ReplicationStats'

# Expected: PendingCount low, FailedCount zero
```

### 6.5 Capacity Management

```bash
# Total capacity
mc admin info wardenx-primary

# Per-tenant utilization
for org in $(get_active_org_ids); do
  size=$(mc du wardenx-primary/tenants/$org/ --json | jq .size)
  echo "$org: $(numfmt --to=iec --suffix=B $size)"
done

# Alert thresholds:
# - Bucket > 100 GB → review for cleanup opportunities
# - Volume > 80% utilization → plan capacity expansion
# - Single object > 500 MB → investigate
```

### 6.6 Tenant Bucket Provisioning

When a new tenant is onboarded:

```bash
# Create buckets per Module 40 / tenant onboarding workflow
for subbucket in documents generated intake claims cost-reports exports; do
  mc mb wardenx-primary/tenants/<new-org-id>/$subbucket
done

# Apply lifecycle policy
mc ilm rule import wardenx-primary/tenants/<new-org-id>/intake \
  < infra/minio/policies/intake-30-day-lifecycle.json

# Apply object lock on compliance buckets
mc retention set --default COMPLIANCE 7y \
  wardenx-primary/tenants/<new-org-id>/claims

mc retention set --default COMPLIANCE 7y \
  wardenx-primary/tenants/<new-org-id>/cost-reports

# Generate tenant-scoped access key
mc admin user add wardenx-primary tenant-<new-org-id> <generated-secret>

# Apply IAM policy scoping to that tenant's prefix
mc admin policy attach wardenx-primary tenant-<new-org-id> --user tenant-<new-org-id>

# Verify
mc admin user info wardenx-primary tenant-<new-org-id>
```

**Backfill (current deployment).** The application's per-tenant bucket is `tenant-<orgId>`, created by the M34 provisioner at
onboarding. Orgs that predate that lack it: run `bun run ops:backfill-tenant-buckets` (compose: the `tenant-buckets` one-shot,
which `deploy.sh` runs every deploy). It is idempotent; "already exists" is success.

**Attachment scanner (ClamAV).** Message attachments are delivered only after a clamd verdict of clean. The `clamav` sidecar is
internal-network only; its config is `deploy/clamav/clamd.conf` (alerts on encrypted and over-limit files). Alert on attachments
`pending` for more than a few minutes and on repeated `deferred` scans; a down scanner never blocks the EHR, it only withholds
files. `DATABASE_DESTRUCTION_URL` must be set on api and worker (orphan reaper, tenant erase).

---

## 7. Cache Operations (Valkey)

### 7.1 Health Monitoring

```bash
# Quick health
redis-cli -h wardenx-data-01 PING
# Expected: PONG

# Memory info
redis-cli -h wardenx-data-01 INFO memory

# Key stats by namespace
redis-cli -h wardenx-data-01 --bigkeys
# Identify large keys; investigate if unexpected

# Connection count
redis-cli -h wardenx-data-01 INFO clients
```

### 7.2 Memory Management

```bash
# Maxmemory configuration
redis-cli -h wardenx-data-01 CONFIG GET maxmemory
# Expected: <80% of VM RAM, leaving room for OS

# Eviction policy
redis-cli -h wardenx-data-01 CONFIG GET maxmemory-policy
# Expected: allkeys-lru (cache+session DB 0); noeviction (BullMQ DB 1)
```

If memory pressure:

1. Identify large keys: `redis-cli -h wardenx-data-01 --bigkeys`
2. Check key expiration: `redis-cli -h wardenx-data-01 INFO keyspace` — look for expires column
3. If too many non-expiring keys, audit code for missing TTLs
4. Scale up VM if legitimate growth

### 7.3 Snapshot Operations

```bash
# Manual snapshot
redis-cli -h wardenx-data-01 BGSAVE

# Last save time
redis-cli -h wardenx-data-01 LASTSAVE

# Verify snapshot on backup VM
ssh wardenx-backup-01 "ls -la /var/backups/valkey/"
# Expect: dump.rdb mirrored within 15 min of BGSAVE
```

### 7.4 BullMQ Queue Monitoring

```bash
# Connect to BullMQ DB
redis-cli -h wardenx-data-01 -n 1

# Per-queue stats
for queue in claim.submit intake.process notification.deliver; do
  echo "Queue: $queue"
  redis-cli -h wardenx-data-01 -n 1 ZCARD bull:$queue:wait
  redis-cli -h wardenx-data-01 -n 1 ZCARD bull:$queue:active
  redis-cli -h wardenx-data-01 -n 1 ZCARD bull:$queue:failed
done

# Check for backed-up queues
# If wait depth > 1000, investigate worker capacity
```

### 7.5 Stuck Jobs

```bash
# Failed jobs in DLQ
redis-cli -h wardenx-data-01 -n 1 ZRANGE bull:claim.submit:failed 0 -1

# Retry a failed job
# (Use admin UI or BullMQ CLI; raw redis-cli is brittle)

# Clear DLQ after investigation
# Document why before clearing
```

---

## 8. Secret & Credential Management

### 8.1 Secret Inventory

Maintained in `infra/secrets/inventory.yaml` (encrypted via SOPS):

| Secret | Used by | Rotation cadence | Last rotated | Next due |
|---|---|---|---|---|
| `DATABASE_URL` (chartwarden_app) | Backend, workers | Annual | YYYY-MM-DD | YYYY-MM-DD |
| `DATABASE_URL` (chartwarden_admin) | Migrations only | Annual | | |
| `DATABASE_URL` (wardenx_replicator) | Replication | Annual | | |
| `BETTER_AUTH_SECRET` | Backend | Annual | | |
| `VALKEY_PASSWORD` | All services | Annual | | |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | Admin only | Annual | | |
| `MINIO_TENANT_<org>_ACCESS_KEY` / `_SECRET` | Per-tenant data plane | On suspicion or annual | | |
| `ANTHROPIC_API_KEY` | Backend, ml-worker | Quarterly or on suspicion | | |
| `DOSESPOT_CLIENT_ID` / `_SECRET` / per-clinic creds | Backend | Per DoseSpot contract | | |
| `TWILIO_ACCOUNT_SID` / `_AUTH_TOKEN` | Backend (notifications) | Annual | | |
| `POSTMARK_SERVER_TOKEN` | Backend (notifications) | Annual | | |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Backend (subscription billing) | Annual | | |
| `XERO_*` (OAuth refresh tokens) | Cost report worker | Per Xero contract | | |
| `INTERNAL_SERVICE_TOKEN` (backend↔workers) | All | Quarterly | | |
| `M34_TENANT_KEK` (platform KEK wrapping every tenant DEK) | Backend, workers | Annual — **rotatable**, see §8.3.3 | | |
| `M34_TENANT_KEK_RETIRED` (prior KEKs, unwrap-only) | Backend, workers | Pruned only after re-wrap, §8.3.3 | | |
| `TWO_FACTOR_ENCRYPTION_KEY` (TOTP secrets + backup codes) | Backend | **Not rotatable today**, §8.3.3 | | |
| `M24_CREDENTIAL_ENCRYPTION_KEY` (Medicaid trading-partner secrets AND M23 MAC-portal client secrets) | Backend | **Not rotatable today**, §8.3.3. Required in production (boot refuses without it); unset elsewhere, `POST /api/v1/billing/mac-credentials` and M24 credential writes answer 503 `SEAM_UNBOUND` and store nothing | | |
| `CLEARINGHOUSE_VENDOR` + the vendor's own credential (clearinghouse binding, ADR-0053 D3) | Backend | Per vendor contract. Not a secret itself; unset = unbound (`CH_NOT_WIRED`). A vendor named with no adapter in the build, a missing credential, or no database refuses to boot. `stedi` reads `STEDI_API_KEY` and records every submission in `clearinghouse_submission_attempt` (submit side only today) | | |
| `MESSAGING_ENCRYPTION_KEY` (message bodies) | Backend, workers | **Not rotatable today**, §8.3.3 | | |
| `SOPS_AGE_KEY` (decryption key for secrets-in-Git) | Each VM at startup | Annual (with operator presence) | | |
| `PGBACKREST_REPO1_CIPHER_PASS` | Backups | Annual | | |
| `PGBACKREST_REPO2_CIPHER_PASS` | Backup VM | Annual | | |
| `PGBACKREST_REPO3_CIPHER_PASS` | Off-site backup | Annual | | |
| TLS private key (Let's Encrypt) | Edge | Auto-renewed (60 days) | | |
| Private CA root key | Internal mTLS | Every 3 years | | |
| Per-VM mTLS client certs | Inter-service | Annual | | |

### 8.2 Routine Secret Rotation

Schedule annual rotation October each year. Per-secret procedure:

#### 8.2.1 Rotating a Backend Service Secret (Example: `BETTER_AUTH_SECRET`)

```bash
# 1. Generate new secret
NEW_SECRET=$(openssl rand -base64 64)

# 2. Update SOPS-encrypted env file
sops --decrypt infra/secrets/prod.env.sops > /tmp/env-decrypted
sed -i "s/BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=$NEW_SECRET/" /tmp/env-decrypted
sops --encrypt /tmp/env-decrypted > infra/secrets/prod.env.sops
rm /tmp/env-decrypted

# 3. Commit and push (encrypted form)
git add infra/secrets/prod.env.sops
git commit -m "Rotate BETTER_AUTH_SECRET"
git push

# 4. Deploy backend (standard procedure §4.2)
# Backend picks up new secret on startup

# 5. Verify: existing sessions invalidated; users must re-login
# (Better Auth signs sessions with this secret — old sessions fail signature)

# 6. Update inventory
# Edit infra/secrets/inventory.yaml; update last_rotated
```

#### 8.2.2 Rotating a Database Password

```bash
# 1. Create new password
NEW_PASS=$(openssl rand -base64 32)

# 2. Update PG with both passwords valid temporarily
# (Better Auth keeps old session alive; want both passwords valid during deploy)
psql -h wardenx-db-01 -U postgres -c "ALTER ROLE chartwarden_app PASSWORD '$NEW_PASS';"

# 3. Update PgBouncer userlist
ssh wardenx-app-01 "sudo bash -c 'echo \"chartwarden_app=$NEW_PASS\" >> /etc/pgbouncer/userlist.txt'"
ssh wardenx-app-02 "sudo bash -c 'echo \"chartwarden_app=$NEW_PASS\" >> /etc/pgbouncer/userlist.txt'"

# 4. Reload PgBouncer (no connection drop)
ssh wardenx-app-01 "sudo systemctl reload pgbouncer"
ssh wardenx-app-02 "sudo systemctl reload pgbouncer"

# 5. Update SOPS env file with new password
# (As per §8.2.1)

# 6. Deploy backend; verify connections work

# 7. Remove old password from userlist
# Update userlist to only have new password; reload PgBouncer
```

#### 8.2.3 Rotating External API Keys (Example: Anthropic)

```bash
# 1. Generate new API key in Anthropic console
# (Keep old key active for now)

# 2. Update SOPS env
# Add ANTHROPIC_API_KEY=<new>

# 3. Deploy backend and ml-worker

# 4. Verify new key works:
#    - Generate a test HearthNote Layer 2 narrative
#    - Watch for 401 errors in logs
#    - Run smoke test that exercises Anthropic call

# 5. After 24 hours of successful operation, revoke old key in Anthropic console

# 6. Update inventory
```

#### 8.2.4 Emergency (Suspected Compromise) Rotation

Triggers:
- Secret accidentally committed to public repo
- Vendor reports key exposure
- Suspicious activity attributable to a specific credential

```bash
# 1. Immediately revoke the compromised credential at source
# (For external services: revoke in vendor console)
# (For internal: revoke in DB / SOPS)

# 2. Generate replacement
# 3. Roll out replacement urgently (not via maintenance window)
# 4. Investigate scope of compromise
# 5. HIPAA breach assessment if PHI access possible
# 6. Document in incident retrospective
```

### 8.3 Key Rotation (Encryption Keys)

Different from credentials. Encryption keys must be rotated with backward-compatibility consideration since old data was encrypted with old keys.

#### 8.3.1 pgBackRest Cipher Rotation

```bash
# 1. Generate new cipher
NEW_PASS=$(openssl rand -base64 48)

# 2. pgBackRest does not natively support cipher rotation
# Approach: create new stanza with new cipher; cut over

# 3. Configure new stanza
sudo -u postgres pgbackrest --stanza=chartwarden-v2 --repo1-cipher-pass=$NEW_PASS stanza-create

# 4. Take fresh full backup under new stanza
sudo -u postgres pgbackrest --stanza=chartwarden-v2 --type=full backup

# 5. Verify backup is good
sudo -u postgres pgbackrest --stanza=chartwarden-v2 --type=full verify

# 6. Update postgresql.conf to use new stanza for archive-push
# 7. Cut over backup scheduling to chartwarden-v2
# 8. Retain old stanza chartwarden for historical backup restoration only
# 9. After 6 months (per retention class), retire old stanza
```

#### 8.3.3 Application Encryption Keys (KEKs)

Four master keys encrypt data at rest in the application layer (ADR-0038 — the mechanism is
AES-256-GCM in the app process, never pgcrypto). They do **not** rotate alike, and the difference is
structural rather than a matter of procedure.

**`M34_TENANT_KEK` — rotatable (ADR-0045).** Each tenant's DEK is 32 random bytes *wrapped* under
this KEK, and `tenant_key_ring.current_dek_kek_id` records which KEK wrapped it. Rotation is
therefore additive: introduce the new key as active, keep the old one readable, re-wrap at leisure.

```bash
# 1. Mint the new KEK. The id must be new; it is what stored rings resolve by.
NEW_KEK="kek-$(date +%Y%m):$(openssl rand -base64 32)"

# 2. Move the CURRENT active key into the retired (unwrap-only) list, then set the new active key.
#    Order matters: a deploy that drops the old key before every ring is re-wrapped makes those
#    tenants' ciphertext unreadable. Retired keys are only ever removed AFTER step 4 reports zero.
#    (in .env.production, via SOPS)
#      M34_TENANT_KEK_RETIRED=<previous M34_TENANT_KEK>[,<older entries…>]
#      M34_TENANT_KEK=$NEW_KEK

# 3. Roll the API + worker containers. New tenants wrap under the new KEK immediately; existing
#    rings keep resolving through the retired entry.

# 4. Re-wrap existing tenants by rotating their DEKs (the `tenant.dek_rotate` job re-mints and
#    re-wraps under whatever KEK is active). Which rings still name an old KEK:
#      SELECT current_dek_kek_id, count(*) FROM tenant_key_ring
#       WHERE destroyed_at IS NULL GROUP BY 1;

# 5. Only once that query returns the new kekId alone, prune M34_TENANT_KEK_RETIRED and roll again.
```

**`TWO_FACTOR_ENCRYPTION_KEY`, `M24_CREDENTIAL_ENCRYPTION_KEY`, `MESSAGING_ENCRYPTION_KEY` — not
rotatable today.** All three HKDF-*derive* their per-scope DEK from the master key, so the master key
is not a wrapper that can be swapped: changing it changes every derived DEK, and every existing
ciphertext becomes unreadable at once. Their at-rest format reserves a version byte for a future
two-key read path (ADR-0034 §3), and nothing implements one. Until it does, treat a compromise of any
of the three as requiring a **re-encryption project**, not a rotation — and note that the affected
data is recoverable by re-entry (a user re-enrols 2FA; an operator re-enters a trading-partner
secret) except for message bodies, which are not.

> **Update (M36 WP 2.13, ADR-0058 P1; code on branch `feat/m36-wp213-body-key-ring`, backfill not yet run anywhere):** message
> bodies are moving off `MESSAGING_ENCRYPTION_KEY` onto the M34 wrapped-DEK ring (`tenant_key_ring`), which rotates (a new DEK
> version; old rows stay readable by their recorded version) and shreds (destroying the ring makes ring-sealed bodies unreadable).
> Until the backfill has finished for every tenant, and the backups that hold legacy ciphertext have aged out, the paragraph above
> still applies to the rows still on the legacy envelope. Operator procedure, escrow-drill checklist and rollback limits:
> [`docs/runbooks/m36-body-key-ring.md`](../runbooks/m36-body-key-ring.md).

**Losing `M34_TENANT_KEK` without a retired copy is unrecoverable by design** — it is the same
property that makes the M34 cryptographic shred real, pointed the wrong way. It belongs in the sealed
off-site envelope alongside `SOPS_AGE_KEY` (§8.4).

#### 8.3.2 TLS Certificate Rotation

**Let's Encrypt (public-facing, auto-renewed):**

```bash
# Certbot/acme.sh handles automatic renewal 30 days before expiration
# Verify state:
ssh wardenx-edge-01 "certbot certificates"

# Check next renewal time
ssh wardenx-edge-01 "systemctl list-timers | grep certbot"
```

If auto-renewal fails (e.g., DNS challenge issue):

```bash
ssh wardenx-edge-01 "sudo certbot renew --dry-run"
# Diagnose and fix DNS config
```

**Private CA (internal mTLS):**

Annual rotation; manual procedure in offline secure environment:

```bash
# 1. Generate new intermediate CA cert/key on offline machine
# 2. Sign with root CA private key (held offline)
# 3. Distribute new intermediate CA to all internal services as trust anchor
# 4. Generate new service certs with new CA chain
# 5. Roll out new service certs (rolling restart)
# 6. Old certs valid for 30-day overlap window
# 7. Revoke old certs after rollout complete
```

### 8.4 SOPS / Age Key Management

The age key that decrypts all SOPS-encrypted secrets is a critical artifact:

- **Primary copy** on each production VM in `/etc/wardenx/age.key` (mode 0400, owner: systemd service user)
- **Backup copy** in sealed envelope in fire safe at primary location
- **Recovery copy** in second sealed envelope at off-site location (trusted secondary holder — currently Fabrice's designated successor; documented separately)
- **Test annually:** decrypt a known SOPS-encrypted file using the off-site copy

If age key suspected compromised:

```bash
# 1. Generate new age key
age-keygen -o new-age.key

# 2. Decrypt all SOPS files with old key
for file in infra/secrets/*.sops; do
  sops --decrypt $file > $file.decrypted
done

# 3. Re-encrypt with new key
# Update .sops.yaml with new public key

for file in infra/secrets/*.decrypted; do
  sops --encrypt $file > ${file%.decrypted}
  rm $file
done

# 4. Distribute new private key to all VMs (over secure channel)
# 5. Update sealed envelope copies
# 6. Verify all services start successfully
# 7. Securely destroy old key copies
# 8. Document the rotation
```

### 8.5 Break-Glass Credentials

For emergency admin access when normal channels unavailable:

- One break-glass `chartwarden_admin` PostgreSQL credential, password sealed in offline envelope
- One break-glass MinIO root credential, similarly sealed
- One break-glass SSH key for `wardenx-edge-01` (host of last resort), sealed

**Usage triggers:**
- Total directory service failure
- Standard credentials compromised
- DR scenario requiring elevated access

**Procedure:**
1. Open sealed envelope; document time and reason
2. Use credential for specific task
3. Immediately rotate after use
4. Reseal new credential

All break-glass usage:
- Logged in physical security log
- Logged in `audit_event` with severity=critical, event_type=`security.break_glass_used`
- Reviewed by compliance officer within 24 hours

---

## 9. Monitoring & Alerting Operations

### 9.1 Adding New Alerts

```yaml
# alerts/<area>/<name>.yaml in Git
name: <SnakeCaseName>
severity: SEV-1 | SEV-2 | SEV-3 | SEV-4
metric: prometheus_query_expression
condition: > | < | ==
threshold: <value>
duration: <e.g. "5m">
labels:
  module: <module_name>
  team: ops
annotations:
  summary: "Human readable one-liner"
  runbook: "Link to specific section of this doc"
  description: "What is happening; what to investigate"
```

Promote alert via PR. Reviewer checks:
- Severity is justified
- Threshold is non-flaky (false positive rate <5%)
- Annotations point to actionable runbook section
- Existing alerts not redundant

### 9.2 Alert Tuning

#### 9.2.1 False Positive Reduction

Monthly review (cadence §3.3):

```bash
# Pull last 30 days of alert firings
# Categorize: actionable, false positive, low-value

# For each false positive, adjust threshold OR duration OR condition
# For low-value (fired but didn't need to), demote severity or remove
# For actionable, leave as-is
```

#### 9.2.2 Alert Fatigue Indicators

- Same alert firing > 3 times in a week → tune
- Alert resolved itself without action → tune
- Alert ignored for > 1 hour during active hours → demote or remove
- Operator habit of dismissing without reading → critical issue; signals bad alert design

### 9.3 Dashboard Maintenance

Dashboards committed to Git as JSON in `infra/grafana/dashboards/`. Changes via PR:

- Test in staging Grafana first
- PR includes screenshot of new view
- Reviewer checks panels are PHI-free (no patient-identifiable info)

### 9.4 Synthetic Monitoring

Synthetic tests run from external location to verify external availability:

```yaml
# infra/monitoring/synthetic-tests.yaml
- name: backend_health
  interval: 60s
  request:
    method: GET
    url: https://api.wardenx.app/health
  expect:
    status: 200
    body_contains: '"status":"ok"'

- name: status_page
  interval: 300s
  request:
    method: GET
    url: https://status.wardenx.app/
  expect:
    status: 200

- name: tenant_login_flow
  interval: 600s
  request:
    method: POST
    url: https://engrace.wardenx.app/api/v1/auth/synthetic-check
  auth: synthetic-test-token
  expect:
    status: 200
```

Tests run from at least 2 external locations (avoiding single-point-of-monitoring-failure).

---

## 10. Cost & Capacity Operations

### 10.1 Vendor Spend Tracking

| Vendor | Monthly Watch |
|---|---|
| Anthropic | Token usage per capability; per-tenant attribution; budget alarms at 50% / 75% / 90% of monthly cap |
| Twilio | SMS volume; per-tenant attribution; spike investigation if >2× baseline |
| Postmark | Email volume; bounce rate trends |
| Stripe | Fee analysis; chargebacks; failed payment trends |
| MinIO storage (if cloud) | Storage growth rate; bandwidth costs |
| Proxmox hosting (if colocated) | Power, bandwidth, hardware service |

Monthly review consolidates into a vendor-spend report stored in `docs/ops/cost-reports/<YYYY-MM>.md` (**`docs/ops/` does not exist** — create on first report).

### 10.2 Anthropic Cost Watch — Concrete Procedure

Anthropic spend is the largest variable cost and most worth governing closely:

```bash
# 1. Pull current month token usage from Anthropic dashboard
# (Anthropic Console → Usage)

# 2. Compare to budget
# Engrace-only baseline: ~$X/month for HearthNote Layer 1 only
# With Layer 2 enabled: ~$Y/month projected

# 3. Per-tenant attribution
# Query wardenx audit_event for ai_capability_used events
psql -h wardenx-db-02 -U readonly -d wardenx -c "
SELECT organization_id, context->>'capability' AS capability,
       SUM((context->>'input_tokens')::int) AS input_tokens,
       SUM((context->>'output_tokens')::int) AS output_tokens
FROM audit_event
WHERE event_type = 'ai.capability_invoked'
  AND created_at > date_trunc('month', NOW())
GROUP BY organization_id, capability
ORDER BY input_tokens DESC;
"

# 4. Compute cost per tenant from token usage × Anthropic rate

# 5. Compare to subscription revenue per tenant
# If cost > 30% of revenue, investigate and potentially impose per-tenant ceiling

# 6. Alert if budget at 90% before month end
```

### 10.3 VM Capacity Monitoring

```bash
# Per-VM resource utilization
for vm in $(get_all_vms); do
  ssh $vm "uptime; free -h; df -h /var/lib/postgresql 2>/dev/null || df -h /"
done

# Specifically watch:
# - Disk usage approaching 80% on wardenx-db-01, wardenx-storage-01, wardenx-backup-01
# - Memory pressure on wardenx-app-* (frequent OOM kills indicate insufficient RAM)
# - CPU sustained > 80% (need to scale up worker VMs)

# Prometheus alerts:
# - disk_usage > 70% → SEV-3 warning
# - disk_usage > 85% → SEV-2 critical
# - memory_pressure > 80% for 1 hour → SEV-3 warning
# - cpu_load > vcpus*0.8 for 1 hour → SEV-4 informational
```

### 10.4 Scale-Up Procedures

#### 10.4.1 Add Backend Instance (Horizontal Scale)

When current instances at sustained > 70% utilization:

1. Clone Proxmox VM template `wardenx-app-template`
2. Name: `wardenx-app-03`
3. Configure networking (assign VLAN 20 IP)
4. Run Ansible role `wardenx-backend-host` to provision
5. Add to Pangolin upstream pool at weight 0
6. Verify health endpoint
7. Ramp weight to match peers
8. Update VM inventory

#### 10.4.2 Scale Database Vertical

If wardenx-db-01 needs more resources:

1. Schedule maintenance window
2. Failover to wardenx-db-02 (DR_BCP §6.1)
3. Shutdown wardenx-db-01
4. Increase VM resources via Proxmox UI
5. Restart wardenx-db-01 as new replica
6. Failback after sync complete (optional)
7. Repeat on wardenx-db-02 in next maintenance window

#### 10.4.3 Scale Storage

When MinIO approaching capacity:

1. Add disk to wardenx-storage-01 VM via Proxmox
2. Extend MinIO server with new disk
3. Verify capacity in MinIO console

If single VM can't grow, transition to distributed MinIO (multi-node mode) — major operational change requiring planning.

### 10.5 Budget Forecasting

Quarterly forecasting:
- Last 3 months actual spend per category
- Customer growth projection (1 tenant now → 2-3 by Phase 2)
- Per-tenant cost model
- 12-month forward projection
- Investment triggers (e.g., "if at 3 tenants, add second backend VM; if at 5 tenants, transition to managed Postgres")

---

## 11. Tenant Operations

### 11.1 New Tenant Onboarding

Steps after sales/contract complete (full automation lives in Module 34 SaaS Tenant Platform; this is the manual fallback / verification):

> **`packages/db/scripts/` DOES NOT EXIST**, and never has. Every `bun packages/db/scripts/*.ts`
> command previously in this chapter was non-executable. Tenant operations are **HTTP routes on the
> M34 platform-ops surface**, not CLI scripts — that is deliberate (each one is ABAC-gated,
> step-up-gated where destructive, and audited; a script bypassing the API would bypass all three).
> Below, each step is either its real route, or marked **NOT IMPLEMENTED** where no equivalent
> exists. All routes need a platform-ops session; `$API` is `https://wardenx-app-01:3000`.

```bash
# 1. Create the tenant (organization + tenant_account spine)
curl -sf -X POST $API/api/v1/platform/tenants \
  -H "authorization: Bearer $PLATFORM_OPS_TOKEN" -H "content-type: application/json" \
  -d '{"slug":"<slug>","legalBusinessName":"<Legal Name>","displayName":"<Display>"}'

# 2. Create ProviderEntity (CCN)  →  NOT IMPLEMENTED as an operator route.
#    `provider_entity` has no create route on any surface. Today it is seeded by
#    `scripts/db/seed.ts` or written directly via psql. Treat as a DB operation and record it in
#    the change log; do not expect an API.

# 3. Create initial Locations  →  NOT IMPLEMENTED as an operator route (same as step 2).

# 4. Provision MinIO buckets (§6.6) — per-tenant bucket is `tenant-<organizationId>`.

# 5+6. Invite the first admin. Self-serve signup (M34 §5) mints this as part of the signup-intent
#      flow; for a sales-led tenant, use the tenant-scoped invitation surface:
curl -sf -X POST $API/api/v1/invitations \
  -H "authorization: Bearer $ORG_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"email":"<admin@tenant.com>","roleKeys":["org_admin"]}'
#      The invitee accepts at POST /api/v1/invitations/accept, which creates the membership.
#      NOTE: `org_admin` and `administrator` are two DISTINCT roles — see §7's role catalog.

# 7. Configure tenant settings  →  NOT IMPLEMENTED as an operator route.
#    `organization_setting` rows (e.g. `org_timezone`, `breakglass_cosign_required`) are written by
#    the owning module's own admin surface or by psql. There is no generic settings CLI or route.

# 8. Set initial feature flags — the M34 admin surface:
curl -sf -X POST $API/api/v1/platform/feature-flags \
  -H "authorization: Bearer $PLATFORM_OPS_TOKEN" -H "content-type: application/json" \
  -d '{"key":"<flag>","enabled":false,"organizationId":"<orgId>"}'
# (Phase 1 defaults; Layer 2 and DocLens initially off)

# 9. Configure billing (if subscription tenant)
# Stripe customer + subscription

# 10. Verify by signing in as admin user
# 11. Confirm BAA executed and on file (compliance check)
# 12. Tenant added to monitoring dashboards

# 13. Customer success: kickoff call, training, data migration plan
```

### 11.2 Tenant Suspension

Reasons:
- Customer payment failed and grace period expired
- Customer request (pause)
- Compliance issue (suspected misuse)

Effects of suspension:
- All users cannot sign in
- Read-only API still functions for compliance access
- Billing pauses (subscription on hold or paused at Stripe)
- Customer notified
- 90-day window before potential closure

```bash
# Procedure — the M34 platform-ops status transition (ABAC + step-up gated, audited).
curl -sf -X POST $API/api/v1/platform/tenants/<slug>/status \
  -H "authorization: Bearer $PLATFORM_OPS_TOKEN" -H "content-type: application/json" \
  -d '{"status":"suspended","reason":"<reason>"}'

# This sets tenant_account.status = 'suspended'
# Better Auth refuses sign-in for suspended orgs
# Backend middleware blocks mutations except for admin export
# Audit log entry emitted
# Customer notification sent
```

### 11.3 Tenant Closure

Permanent. Triggers data retention countdown.

```bash
# 1. Confirm customer instruction in writing
# 2. Final data export (offered to customer per BAA termination)
# The tenant-export job (M34 §4.3). It produces a real ustar tar.gz with a manifest sidecar;
# an oversized bundle is HELD and needs the SEC-052 approval route before it releases.
curl -sf -X POST $API/api/v1/tenant/tenant-export-jobs \
  -H "authorization: Bearer $ORG_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"reason":"BAA termination — final export"}'
# Platform-ops list + oversized approval:
#   GET  $API/api/v1/platform/tenant-export-jobs
#   POST $API/api/v1/platform/tenant-export-jobs/<id>/approve-oversized

# 3. Verify export integrity; transmit to customer via secure channel

# 4. Schedule data destruction per retention rules
# Retention period: per Architecture §24 clinical record retention
# Actual destruction: after retention period elapses

# 5. Set organization.status = 'closed'
# 6. Revoke all memberships
# 7. Final audit log entries
# 8. Stripe subscription canceled
# 9. Compliance officer signs off
```

### 11.4 Data Subject Access Requests (DSAR)

HIPAA Right of Access — patient requests their own records:

```bash
# 1. Verify patient identity (must be via tenant agency since they're the covered entity)
# 2. Determine scope (full record vs. specific date range vs. specific document)
# 3. Tenant agency initiates the export via Module 22 / admin UI
# 4. ChartWarden assists with export generation if needed

# The M34 DSAR export job (tenant-scoped; the tenant IS the covered entity, so this runs on the
# tenant's own surface, not platform-ops).
curl -sf -X POST $API/api/v1/tenant/dsar-export-jobs \
  -H "authorization: Bearer $ORG_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"patientId":"<uuid>","reason":"HIPAA Right of Access"}'
#   GET  $API/api/v1/tenant/dsar-export-jobs            — status
#   POST $API/api/v1/tenant/dsar-export-jobs/<id>/fulfill
#   POST $API/api/v1/tenant/dsar-export-jobs/<id>/extend — the one 30-day extension

# 5. Tenant delivers to patient per HIPAA timeline (30 days; one 30-day extension allowed)
# 6. Document fulfillment in audit log
```

### 11.5 Data Portability Requests

Patient requesting electronic copy in transferable format (HIPAA right):

```bash
# 1. Same identity verification as DSAR
# 2. Generate FHIR R4 bundle (preferred portable format)
# NOT IMPLEMENTED as a FHIR bundle. The DSAR job above is the only patient-record export path,
# and it does not emit a FHIR R4 bundle: M28's FHIR read surface returns hardcoded 404/empty-Bundle
# with no data path, and bulk `$export` has neither a route nor a worker. Until that lands,
# portability is served by the DSAR export in its native format.

# 3. Deliver via secure channel
```

### 11.6 Compliance-Driven Data Holds

Legal hold (litigation, audit, investigation) per Architecture §24.3:

```bash
# 1. Compliance officer triggers
curl -sf -X POST $API/api/v1/legal-holds \
  -H "authorization: Bearer $COMPLIANCE_TOKEN" -H "content-type: application/json" \
  -d '{"scope":{"patientId":"<uuid>"},"reason":"<docket>"}'
#   GET  $API/api/v1/legal-holds              — active holds
#   POST $API/api/v1/legal-holds/<id>/release — release when the obligation lapses

# 2. All matching records' retention_class flipped to 'legal_hold'
# 3. Retention jobs skip 'legal_hold' records
# 4. Audit event: data.legal_hold_applied
# 5. Documentation: hold notice retained in legal docs folder
```

---

## 12. Compliance Operations

### 12.1 Annual HIPAA Security Risk Analysis

Mandatory annually per HIPAA Security Rule §164.308(a)(1)(ii)(A). Scope:

- All ePHI created, received, maintained, transmitted by ChartWarden
- All systems, applications, devices touching ePHI
- All third-party services receiving ePHI

Process:

1. January: engagement with qualified external assessor (contract in place by then)
2. Document review: policies, procedures, training records, audit logs
3. Technical review: architecture, controls, vulnerabilities
4. Site walkthrough or remote equivalent
5. Findings report
6. Risk mitigation plan with timeline
7. Sign-off by compliance officer and engineering
8. Filed for 6+ years per §164.316(b)(2)

### 12.2 Quarterly Access Review

```bash
# 1. Pull active users by role
psql -h wardenx-db-02 -U readonly -d wardenx -c "
SELECT u.email, u.name, o.slug, m.status, m.accepted_at, 
       (SELECT MAX(created_at) FROM audit_event WHERE actor_user_id = u.id) AS last_active
FROM \"user\" u
JOIN membership m ON m.user_id = u.id
JOIN organization o ON o.id = m.organization_id
WHERE m.status = 'active'
ORDER BY o.slug, u.email;
"

# 2. For each tenant, the org_admin certifies that each user listed:
#    - Is still employed/contracted
#    - Has access appropriate to current role
#    - Has used the system in past 90 days (dormant accounts flagged)

# 3. Revoke memberships for departed users
# 4. Update roles for changed responsibilities
# 5. Disable dormant accounts (no login in 90 days)
# 6. Document certification with timestamp and signature
```

### 12.3 Audit Log Review

Monthly, compliance officer reviews:

```sql
-- High-risk events from past month
SELECT event_type, actor_user_id, organization_id, severity, context
FROM audit_event
WHERE created_at > date_trunc('month', NOW()) - INTERVAL '1 month'
  AND created_at < date_trunc('month', NOW())
  AND severity IN ('warn', 'critical')
ORDER BY severity DESC, created_at DESC;

-- Admin actions (cross-tenant for platform_ops, sensitive within tenant for org_admin)
SELECT event_type, actor_user_id, organization_id, context
FROM audit_event
WHERE event_type LIKE 'admin.%' OR event_type LIKE 'platform.%'
ORDER BY created_at DESC LIMIT 100;

-- PHI export events
SELECT *
FROM audit_event
WHERE event_type IN ('phi.exported', 'phi.bulk_read', 'patient.exported')
ORDER BY created_at DESC;

-- RLS denials (cross-tenant attempts — should be zero or very low)
SELECT * FROM audit_event WHERE event_type = 'security.rls_denied';
```

Findings documented; anomalies investigated.

### 12.4 BAA Renewal Tracking

Quarterly:

```bash
# Pull BAA inventory
# (Spreadsheet or, when Module 40 MDM matures, vendor table)

# Status per vendor:
# - In force (date range)
# - Expiring within 90 days → renewal in progress
# - Expired → immediate action
# - N/A (vendor doesn't handle PHI)

# Required BAAs in place:
# - Anthropic (in negotiation as of Phase 1 design)
# - DoseSpot (executed)
# - Twilio HIPAA tier (executed)
# - Postmark HIPAA tier (executed)
# - Hosting provider (if Proxmox colocated — varies)
# - Off-site backup provider (per choice)
# - External clinical partners that receive PHI via Module 22
```

### 12.5 Policy Review

Annual review of every policy:

- Information Security Policy
- Data Classification Policy
- Access Control Policy
- Incident Response Policy
- Backup and Recovery Policy
- Acceptable Use Policy
- Vendor Management Policy
- Workforce Training Policy
- Sanction Policy
- Privacy Policy (HIPAA Privacy Rule §164.520)
- Notice of Privacy Practices (for direct-to-patient via portal)
- Breach Notification Policy
- Risk Management Policy

Each policy:
- Reviewed for currency
- Updated for any architectural / regulatory changes
- Re-signed by compliance officer + ChartWarden leadership
- Distributed to workforce (training updates)
- Filed in `docs/policies/<name>-vYYYY-MM.md` (**directory does not exist** — create on first policy)

### 12.6 Workforce Training

Annual training mandatory per §164.308(a)(5):

- HIPAA Privacy and Security Rule basics
- ChartWarden-specific policies
- Phishing awareness
- Incident reporting procedures
- Password/credential hygiene

Trainings tracked; completion required for continued access; refresher annually.

---

## 13. Routine Incident Response

### 13.1 SEV-3 Common Scenarios

#### 13.1.1 Slow Query Alert

```
Alert: db_query_p95_high
```

1. Check Grafana DB dashboard for which query
2. Investigate via §5.4
3. If new query: add appropriate index, deploy
4. If existing query slowed: data growth? Vacuum issue? Recent migration?
5. Mitigation: query timeout limits prevent runaway

#### 13.1.2 Worker Queue Backlog

```
Alert: bullmq_queue_depth_high
```

1. Identify which queue
2. Check worker logs for processing errors
3. If errors transient: workers will catch up
4. If sustained errors: investigate root cause
5. Temporary: add worker concurrency
6. Long-term: investigate why job creation rate exceeds processing

#### 13.1.3 Replication Lag

```
Alert: db_replication_lag_high
```

1. Check primary write rate — heavy spike?
2. Check replica disk I/O — bottleneck?
3. Check network between primary and replica
4. If conflict (replica running long query): kill the conflicting query if safe
5. If structural: increase replica resources

#### 13.1.4 Disk Space Approaching Threshold

```
Alert: disk_usage_high (70% warning, 85% critical)
```

1. Identify which VM and which mount
2. Common: PG data dir, audit_event partitions (rotate older to cold), MinIO buckets
3. Procedure:
   - PG: vacuum, archive old partitions, possibly grow volume
   - MinIO: lifecycle policy review, possible bucket cleanup
   - Backup VM: extend retention vs. archive to off-site

#### 13.1.5 Certificate Expiration Approaching

```
Alert: tls_cert_expiry_soon (30 days, 7 days)
```

1. Verify auto-renewal status (Let's Encrypt)
2. If auto-renewal blocked, debug DNS or ACME challenge
3. Manual renewal if needed (§8.3.2)

### 13.2 SEV-4 Routine Scenarios

| Scenario | Response |
|---|---|
| Backup verification soft failure | Review log; rerun verification; investigate if pattern |
| Dependency security warning (non-critical CVE) | Add to next patch cycle |
| Single non-prod environment failure | Wait until business hours; fix |
| Outdated dependency PR (Renovate) | Schedule for next patch cycle |

### 13.3 Common Quick Fixes

#### "Backend is slow"

```bash
# 1. Check load balancer health
ssh wardenx-edge-01 "/etc/wardenx/lb-cli show"

# 2. Check per-instance latency
curl -w "@curl-timing.txt" -sf https://wardenx-app-01:3000/health

# 3. Check DB connection pool
ssh wardenx-app-01 "psql -h localhost -p 6432 -U pgbouncer pgbouncer -c 'SHOW POOLS;'"

# 4. Check for slow queries (§5.4)

# 5. Check Sentry for new errors

# 6. Check external dependency health (Anthropic, DoseSpot)
```

#### "I can't log in"

```bash
# 1. Verify Better Auth service
curl -sf https://api.wardenx.app/api/v1/auth/health

# 2. Check session table state
psql -c "SELECT COUNT(*) FROM session WHERE expires_at > NOW();"

# 3. Check Valkey session storage
redis-cli PING

# 4. User account state
psql -c "SELECT email, status FROM \"user\" WHERE email='<email>';"

# 5. Membership state
psql -c "SELECT * FROM membership WHERE user_id=<id>;"
```

#### "Claim won't validate"

```bash
# 1. Identify which rule failed
# Check claim.validation_result for the claim

# 2. If rule failure expected: user follows remediation hint
# 3. If rule misbehaving: bug; investigate Module 23 §11.A logic
```

---

## 14. On-Call Procedures

### 14.1 Going On-Call

Checklist (at start of shift):

- [ ] PagerDuty schedule check — confirmed primary
- [ ] Phone configured for PD ringer override
- [ ] Laptop with VPN tested working
- [ ] Bastion access tested
- [ ] Status page admin access tested
- [ ] Acknowledged handoff from outgoing on-call

### 14.2 Receiving an Alert

Within 5 minutes (SEV-1) / 15 minutes (SEV-2) / 1 hour business hours (SEV-3) / next-business-day (SEV-4):

- [ ] Acknowledge in PagerDuty
- [ ] Open incident channel (Slack #incident-<id>)
- [ ] Start incident timeline doc
- [ ] Triage: real issue vs. alert false positive?
- [ ] If real: declare severity, follow appropriate runbook
- [ ] If false positive: silence alert temporarily, file ticket to retune

### 14.3 Going Off-Call

Handoff log format:

```markdown
# On-Call Handoff — YYYY-MM-DD

## Open incidents
- INC-<id>: <title> — <severity> — <status>

## Watch items (not incidents, but monitor)
- <observation>

## Customer commitments
- <commitment> due <date>

## Vendor escalations in progress
- <vendor> case <id>

## Notes for next on-call
<free-form>
```

### 14.4 Escalation Paths

| Scenario | Escalation |
|---|---|
| Cannot resolve SEV-1 within 30 min | Engage IC (if not already); consider engaging external consultant |
| Suspected security breach | Compliance officer + counsel within 1 hour |
| Database corruption | Pause; double-check before any restore; consider engaging PG consultant |
| Customer-impact incident running > 2 hours | IC reviews with customer success; consider customer-side compensation |
| Multi-customer impact | All hands on deck; escalate communications |

---

## 15. Routine Maintenance Windows

### 15.1 Pre-Maintenance Checklist

- [ ] Customer notification sent ≥ 7 days in advance
- [ ] Status page maintenance event scheduled
- [ ] Backup completed within last 24 hours
- [ ] Rollback plan documented
- [ ] Smoke tests prepared for post-maintenance
- [ ] On-call available throughout window

### 15.2 During Maintenance

- Status page updated when maintenance starts
- Updates every 30 min if longer than 1 hour
- Internal incident channel even though planned (for documentation)

### 15.3 Post-Maintenance

- Smoke tests pass
- Status page returned to operational
- Customer notification of completion (if customer-impacting)
- Post-maintenance report in next weekly review

---

## 16. Tooling & Access Management

### 16.1 Bastion / SSH Access

- All production SSH via bastion VM (`wardenx-bastion-01`)
- Bastion has its own MFA-protected admin authentication
- All SSH sessions audited (recorded session logs retained 6 years)
- Per-engineer SSH keys; no shared keys
- Keys rotated annually (§8.2.1 equivalent for keys)

### 16.2 Database Admin Access

```
Connection rules:
- chartwarden_app: from backend VMs only, via PgBouncer, password-authenticated
- wardenx_replicator: from replica VM only, IP-restricted
- chartwarden_readonly: from observability VM and explicit engineer connections, audit-logged
- chartwarden_admin: from migration runner only OR break-glass; password sealed offline
- postgres (superuser): break-glass only
```

Database admin access (chartwarden_admin or postgres role):

- Triggered by maintenance or emergency
- Logged in physical security log
- Audited in audit_event with event_type=admin.db_access_initiated
- Time-bound: session must end within stated window

### 16.3 Production Access Policy

| Role | Read access | Write access | Approval required |
|---|---|---|---|
| Engineer (Fabrice) | Yes (via tools) | Yes (deploys) | Self-approved at solo dev phase; PR review at multi-engineer phase |
| Compliance Officer | Yes (audit log) | No | N/A for read |
| External consultant | Time-bound, audited | No | Compliance officer approval + contract on file |
| Vendor support | No direct access | No | N/A — vendors troubleshoot via support tickets |

### 16.4 Audit of Admin Actions

Every admin (chartwarden_admin role, platform_ops user) action audited:

- Logged in audit_event
- Reviewed monthly by compliance officer
- Anomalies investigated

### 16.5 Platform Role Grants (platform operators, AI Safety Owner)

Platform authority is a role KEY that only confers anything on a **platform-owned** role row
(`organization_id IS NULL`): the `platform_*` keys and `ai_safety_owner` (GAP-003 / GAP-096). A
tenant-owned row carrying one confers nothing, migration 0318 refuses to insert a `platform_*` one, and
the M3 role routes refuse to create or assign any of them (`422 RESERVED_ROLE`). The M34 platform-ops
console therefore cannot bootstrap its own first operator. The one production path is the operator CLI
`scripts/db/platform-role.ts`:

```bash
# Grant (idempotent: a re-run reports "already granted" and writes nothing)
DATABASE_ADMIN_URL=<owner connection> bun run db:platform-role grant \
  --email ops@example.com --org <org slug or id> --role platform_ops --ticket CHG-1234

# Revoke (idempotent: "not granted (nothing to revoke)" when there is no binding)
DATABASE_ADMIN_URL=<owner connection> bun run db:platform-role revoke \
  --email ops@example.com --org <org slug or id> --role platform_ops --ticket CHG-1235
```

- **Allowed keys** are exactly the platform keys a predicate reads (`PLATFORM_GRANTABLE_ROLE_KEYS` in
  `packages/auth/src/roles/platform-reserved.ts`): `platform_owner`, `platform_admin`,
  `platform_billing_admin`, `platform_support_t2`, `platform_sales`, `platform_ops`,
  `platform_security_owner`, `ai_safety_owner`. Any other key is refused before the database is touched.
- **The user must already hold an ACTIVE membership** in the named org. A platform role is bound to a
  membership; the CLI never creates users or memberships.
- **Connection.** Use the owner connection the migration runner uses (`DATABASE_ADMIN_URL`, else
  `DATABASE_URL`). `chartwarden_app` cannot write platform-owned rows.
- **What it writes.** It upserts the platform-owned role row (one per key, `role_platform_key_idx`), adds
  the key's M35 template permission grants (`PLATFORM_OPS_ROLE_GRANTS`) for keys already in the
  `permission` mirror (it warns about missing ones; run `bun run db:sync:permissions` first), deletes any
  legacy tenant-owned row with the same key in that org, and binds the role to the membership. Revoke
  deletes only the binding; the platform-owned row stays for other holders.
- **Audit.** All writes run in one transaction with the M4 write-audit triggers live. Each `role`,
  `role_permission` and `membership_role` change lands in `audit_event` with
  `correlation_id = ops-cli:platform-role:<grant|revoke>:<ticket>:<uuid>`. The CLI prints that id; record
  it on the change ticket. `actor_user_id` is NULL because the operator acts on a database connection,
  so the ticket is the attribution. Find the rows with
  `SELECT * FROM audit_event WHERE correlation_id LIKE 'ops-cli:platform-role:%:CHG-1234:%'`.
- **Effect.** Role keys are re-read on every request. Cached permission sets expire within 5 minutes.
- **`clinical_safety_lead` is not granted here.** It is a tenant role. It carries the AI Safety Owner
  authority only on a deployment started with `CHARTWARDEN_SINGLE_TENANT_DEPLOYMENT=true` (M32 §4.7).
- Review platform-role holders in the §12.2 quarterly access review:
  `SELECT u.email, r.key FROM membership_role mr JOIN role r ON r.id = mr.role_id JOIN membership m ON m.id = mr.membership_id JOIN "user" u ON u.id = m.user_id WHERE r.organization_id IS NULL AND r.category = 'platform_staff'`.

### 16.6 M18 EVV capture: device-attestation flag

`EVV_DEVICE_ATTESTATION_ENFORCED` (`.env.production`; `true` or `false`, anything else refuses boot) controls whether EVV check-in, check-out and offline-sync require a valid session device attestation and bind to the session's device. **Default (unset) is OFF**, because no attested mobile client exists yet (ADR-0035); turning it on before one does makes every production capture return 403. Off: capture records the clinician's most-recently-approved device (ties broken by smallest device id), and a client-supplied `evvDeviceId` is accepted only when it is an approved device of that same clinician's membership (the event records against it); any other id returns 403. The assigned-clinician and visit-window guards, break-glass non-bypass and whole-batch offline-sync checks apply in both modes. The backend logs which mode EVV runs in at boot (`M18 EVV capture: ...`). Changing it needs a backend restart.

> **WARNING: do NOT set `EVV_DEVICE_ATTESTATION_ENFORCED=true` yet.** The session-device binding compares the
> session's attestation row id with `evv_device.m2_device_attestation_id`, which is written once at device
> self-registration. Every re-attestation revokes the old attestation row and inserts a new id, so after the
> first attestation expiry or re-attest no approved device matches the session and **every capture returns
> 403**. Enabling the flag requires the binding to move to a stable identity (the device key fingerprint)
> first; that is a tracked follow-up. While the flag is off, `capturedAt`, coordinates and accuracy are
> client-asserted (the server checks the visit window and geofence against what the client sends, not against
> a device-attested clock or fix), so treat EVV timestamps and positions as unattested until it is enabled.

### 16.7 M18 EVV geofence: the geocode dependency (GAP-054)

M18 decides each capture's geofence from the distance between the device fix and the patient's **geocoded service address** (`patient_address.geocode_lat` / `geocode_lng` on the current primary address, read through M5's `PatientAddressReader`). **Nothing in the codebase populates those columns today**: M5's `m5.geocode_address` processor exists as pure code but has no geocoder adapter, no queue worker and no consumer of `patient.address_changed` bound at boot, and no route accepts a coordinate. Until the columns are filled, every capture records `gpsQuality = no_geofence_baseline` (`geofenceDecision = fail_no_baseline`) and is accepted as advisory; no `m18.evv.at_patient_address` event fires, so M17's EVV-driven visit advance stays quiet; and no `geofence_breach_recorded` alert is raised for those captures (a breach needs a measurable distance). Supervisors see the state only as the `no_geofence_baseline` badge on the event, not as an alert.

**Rollout order: geocode first, then rely on the geofence.** Do not treat a green deploy as proof the geofence works.

1. Populate `geocode_lat` / `geocode_lng` for every active patient's current primary address (an operator back-fill under the audited admin credential, or the geocoder adapter once one is approved; sending patient addresses to a third-party geocoder is a disclosure decision, see INTEGRATIONS §routing, and a self-hosted engine keeps them in-perimeter).
2. Check coverage: the backend logs `GAP-054: ...` at boot (warn while any active patient lacks a coordinate or coverage cannot be measured) and exposes `chartwarden_patient_ungeocoded_active_total` on `/metrics` (`-1` = not measured, for example no `DATABASE_PLATFORM_URL`). The target is `0`.
3. Spot-check one capture on the Docker stack: it should return `gpsQuality` of `high` / `acceptable` / `outside_geofence`, not `no_geofence_baseline`.

The gauge counts active patients whose current primary address has no coordinate; a visit pinned to a different, non-primary address is approximated by the primary one. New addresses added after the back-fill stay un-geocoded until the job (or an operator) fills them, so keep the gauge on an alert.

### 16.8 M36 acknowledgment queue: overdue and latency gauges (WP 4.9, ADR-0076)

`/metrics` exposes the supervisors' unacknowledged queue as platform-wide numbers (no tenant, user, request or patient label): `chartwarden_m36_ack_overdue_total` (waiting requests past their deadline), `chartwarden_m36_ack_failed_unreachable_total`, `chartwarden_m36_ack_oldest_overdue_seconds`, `chartwarden_m36_ack_escalation_stalled_seconds` (ADR-0079: age of the oldest request the escalation sweep should already have handled, 0 when none or when `messaging.escalation_timers` is off for the tenant; alert on `> 300` and on `== -1`), `chartwarden_m36_ack_latency_samples` and `chartwarden_m36_ack_latency_seconds{stat="mean"|"max"}` (acknowledgment latency over the trailing 24 h). `-1` means not measured (no `DATABASE_PLATFORM_URL`, or an organisation could not be counted); it is never reported as 0. The repo ships no alert rules: scrape them and alert on, for example, `chartwarden_m36_ack_oldest_overdue_seconds > 900` or `chartwarden_m36_ack_latency_seconds{stat="mean"} > 900`. Independently, the per-minute `messaging.ack_escalation_sweep` raises an ops notice (the log line `platform-ops notice [m36.ack.queue_overdue|m36.ack.latency_high]` and the optional `OPS_ALERT_WEBHOOK_URL` webhook) per organisation, once per breach and at most hourly while it lasts (claimed once across the fleet on the platform Valkey since ADR-0079; per process only when Valkey is unreachable), whether or not `messaging.escalation_timers` is on. The notice names the organisation id and counts only. `/metrics` is unauthenticated in the app and the production nginx config returns 404 for it, so scrape it on the internal backend port. Look at the requests themselves in the app at `/messaging/unacknowledged` (needs `messaging.review`).

---

## 17. Document Maintenance

### 17.1 This Document's Lifecycle

Reviewed quarterly minimum.

Update triggers:

- New procedure devised in response to an incident
- Existing procedure proven inadequate
- Infrastructure changes affecting commands or addresses
- Vendor changes
- Personnel changes

### 17.2 Sign-off Trail

| Version | Date | Reviewer | Notes |
|---|---|---|---|
| v0.1 | 2026-06-08 | Fabrice | Initial document; spans Phase 1 routine operations |

---

## 18. Module 34 — SaaS Tenant Platform Operations (Addendum)

This addendum covers the platform-ops procedures introduced by Module 34 (SaaS Tenant Platform). Once M34 is live it is authoritative over the manual fallback in §11.1: provisioning, cryptographic shred, and support sessions are M34-orchestrated, and this section is the operator's checklist for driving and verifying them. Catastrophic shred-worker recovery (crash mid-phase) lives in DR_BCP §14A.2; the security boundaries (DEK lifecycle, `tenant_platform_writer`) live in Security Hardening §22.

### 18.1 Tenant Provisioning Checklist (M34 §7.1)

Phase 1 is platform-ops-driven (Phase 3 self-serve is gated behind `m34.self_serve_signup`, deny-default). For each new tenant:

- [ ] Step-up satisfied (`passkey_recent_5min`) before the call
- [ ] `POST /api/v1/platform/tenants` with: legal business name, billing contact, breach-notification contact, intended first-admin email, plan label
- [ ] Provision worker (single-concurrency, **idempotent on `tenant_account_id`**) completed each step:
  - [ ] `tenant_account(status='provisioning')` inserted
  - [ ] `m34_provision_tenant_key_ring(...)` (SECURITY DEFINER) created the key ring with `current_dek_version='v1'`, KEK-wrapped DEK populated
  - [ ] Per-tenant MinIO prefixes created with retention policies per §6.6 (`documents,generated,intake,claims,cost-reports,exports`)
  - [ ] M2 `createOrganization(...)` returned `orgId`, patched onto `tenant_account.organization_id`
  - [ ] Eleven canonical `onboarding_task` rows seeded from `onboarding_task_template`
  - [ ] `tenant_invitation` issued (magic link, `expires_at = NOW()+14d`) and dispatched via M36 PHI-sanitized channel
  - [ ] `m34.tenant.provisioned` outbox emitted; state `provisioning → onboarding`
- [ ] **Verification (surveyor query):** `tenant_account_status_event` trail + per-step `audit_event` reconstruct provisioning end-to-end, in order, with actor identity preserved
- [ ] **BAA gate noted:** the `onboarding → active` transition refuses unless an `executed` BAA exists with >90 days to expiry (§18.3 / M34 §7.5)

**Idempotent resume (per M34 §7.7).** If the worker failed mid-way, re-run it — partial rows survive and it resumes from the last completed step. If the DEK was created but the MinIO prefix was not, the re-run creates the prefix and proceeds. If MinIO is down, the worker fails and backs off; the tenant remains in `provisioning` until manual intervention. Never hand-craft the key ring or MinIO prefixes outside the worker.

### 18.2 Cryptographic Shred Approval Workflow (M34 §7.2)

A tenant is shred-eligible only when **all three** conditions hold. Confirm each before approving:

- [ ] **No legal hold** on the tenant or any in-scope record (a `legal_hold` retention class anywhere blocks)
- [ ] **Retention window elapsed** (`tenant_account.retention_ends_at <= NOW()`)
- [ ] **M4 two-approver destruction certificate approved** (the cert requires a second approver per M4 D4)

**Workflow:**

1. The daily `tenant.shred_eligibility_check` cron finds tenants with `retention_ends_at <= NOW()` and no legal hold, emits `m34.tenant.retention_window_reached`, transitions `retained → destruction_pending`, and M36 alert `tenant.shred_pending_approval` routes to the **platform security owner**.
2. Security owner reviews and either **denies** (returns to `retained` with a deferral note) or **approves**.
3. Approval triggers `requestDestruction('saas_tenant_platform_class', {orgId})` against M4 → M4 issues a **pending** destruction certificate → the **second approver** approves it (M4 D4).
4. With the certificate approved, a platform-ops actor invokes `POST /api/v1/platform/tenants/:orgId/shred` with `passkey_recent_2min` step-up **plus the certificate id**.
5. The `tenant.shred` worker runs the four-phase sequence. **Crash recovery and the Phase-3 irreversible boundary are in DR_BCP §14A.2.**

**Operator guardrails:**

- Never approve while a legal hold is present anywhere in scope.
- Never bypass the M4 second approver — a single-approver shred is not permitted.
- If the **eraser-refusal gate** aborts the shred (any eraseFn returned `refused_part_two_retention`), the tenant correctly returns to `retained` with refused-row counts on the certificate. **This is the intended outcome — do not force the DEK destruction.** The DEK is the only key for legally-retained 42 CFR Part 2 ciphertext; `tenant.shred_eligibility_check` re-fires when the Part 2 obligation lapses.

### 18.3 Support-Session Escalation (M34 §7.4)

When a ChartWarden engineer needs access to a tenant's PHI (e.g., a support ticket requiring chart inspection):

1. The **tenant compliance officer** issues a `support_consent_grant` (`POST /api/v1/tenant/support-consent-grants`) with scope, optional `patient_ids`, `grant_reason`, and `expiresAtIsoOffsetHours ≤ 72`; step-up required. The grant is M4-audited and M36-alerted to platform-ops.
2. The engineer (`passkey_recent_5min`) opens a session: `POST /api/v1/platform/support-sessions` with the `grant_id`. The ABAC predicate `support_session_actor_distinct_from_grantor` **refuses if actor == grantor** (D16). Session `expires_at = LEAST(grant.expires_at, started_at + 8h)`.
3. PHI **write** requires per-action elevation: `POST /api/v1/platform/support-sessions/:id/elevate` (`passkey_recent_2min`), M4-audited and M36-alerted to the grantor.
4. The session ends by tenant revocation (cascades), `expires_at`, or manual close; M36 alert `support_session.expired`.

**Escalation triggers — when to pull in the security owner / compliance officer:**

- **Part 2-heightened session** (grant is `patient_scoped` and an in-scope patient carries an M39 Part 2 designation): the session is **read-only**, every access is `severity=critical` with the Part 2 marker, and elevation is **refused**. If the support task genuinely needs a write, escalate — it cannot be done under support session; the tenant must act.
- **Unusual grant pattern** (the same compliance officer issuing many grants, or grants for patients outside an obvious support context): surfaces in M33 dashboards — review with compliance.
- **Break-glass** (no-consent emergency access, D21): `severity=critical`, `actor_kind='break_glass'`; compliance officer reviews within 24 h (cross-ref §8.5 break-glass procedure).

For the forensic reconstruction of who accessed which patient under which grant, use the queries in **DR_BCP §14A.3**.

---

## Appendix A — Cheat Sheets

### A.1 "Something Is Wrong" Quick Triage

```
Where to start?
│
├── Is patient care affected? → Check DR_BCP §2.3 SEV-1
├── Is billing affected? → SEV-3, this doc §13.1
├── Is a single tenant affected? → Investigate tenant config
├── Is everyone affected? → Check infrastructure (DB, backend, edge)
├── Is it intermittent? → External dependency? Network?
└── Just got a Sentry alert? → Read the trace, follow code path
```

### A.2 Common Commands

```bash
# Backend health
curl -sf https://api.wardenx.app/health

# DB health
psql -h wardenx-db-01 -U postgres -c "SELECT NOW();"

# Replica lag
psql -h wardenx-db-02 -U postgres -c "SELECT NOW() - pg_last_xact_replay_timestamp();"

# Valkey ping
redis-cli -h wardenx-data-01 PING

# MinIO health
mc admin info wardenx-primary

# Backup status
ssh wardenx-db-01 "sudo -u postgres pgbackrest --stanza=chartwarden info"

# All VMs status
for vm in $(get_all_vms); do
  echo -n "$vm: "
  ssh $vm "uptime" 2>&1 | head -1
done
```

### A.3 Emergency Contacts

(Stored in `docs/ops/contacts.yaml`, encrypted via SOPS for sensitive entries — **`docs/ops/` does not exist yet**)

- Fabrice direct: ___
- Compliance officer / counsel: ___ (when contracted)
- DoseSpot enterprise support: ___
- Anthropic enterprise support: ___
- Twilio enterprise support: ___
- Postmark enterprise support: ___
- Stripe support: ___
- NGS (MAC J6) EDI hotline: ___
- Oregon Medicaid (OHA) EDI: ___
- iQIES (CMS) help desk: ___
- Hardware vendor support: ___
- Hosting provider (when not Proxmox-self-hosted): ___
- Cyber insurance carrier (Phase 2): ___

---

## Appendix B — Glossary

| Term | Definition |
|---|---|
| **Blue-Green** | Deploy pattern with two identical environments; traffic shifts gradually |
| **Hot-fix** | Urgent code change deployed outside normal release cadence |
| **PITR** | Point-In-Time Recovery |
| **DLQ** | Dead-Letter Queue |
| **DSAR** | Data Subject Access Request |
| **MAC** | Medicare Administrative Contractor |
| **OHA** | Oregon Health Authority |
| **NGS** | National Government Services (Medicare MAC J6) |
| **Renovate** | Automated dependency update bot |
| **SAML/OIDC** | Single sign-on protocols |
| **SOPS** | Secrets management tool (Mozilla) |
| **Age** | Modern file encryption tool used with SOPS |
| **Vacuum** | PostgreSQL maintenance to reclaim dead tuples |
| **WAL** | Write-Ahead Log |
| **HPM** | High-Performance Memcache (terminology no longer used; included for legacy refs) |
| **CIS** | Center for Internet Security (benchmarks) |
| **CVE** | Common Vulnerabilities and Exposures |
| **SBOM** | Software Bill of Materials |

---

## Appendix C — Module 33 (Reporting & Dashboards) Operations

M33 reads **exclusively from the hot-standby replica** via `withReportSession` (`default_transaction_read_only=TRUE`, `application_name='m33_tile'`, tiered `statement_timeout`). It owns no clinical write path; its ops surface is **replica freshness**, **MV refresh health**, and **scheduled-report delivery**.

### C.1 Replica-lag monitoring

A lag-probe singleton queries `pg_stat_replication` every **30 s**. Freshness SLO: steady-state **p50 < 2 s / p95 < 30 s**.

- **Warn at 600 s (10 min)** of lag, with **two-consecutive-probe hysteresis** (one spike does not alarm). On breach the probe emits **`m33.lag.exceeded`** → M36 warn alert to the admin channel → a top-of-page degradation banner appears, and tiles stamp a lag-adjusted `dataFreshnessSeconds` (or fall back to the Valkey `on_demand` cache). Recovery is symmetric: **`m33.lag.recovered`** clears the banner.
- **Align with the platform alert ladder:** replication lag **>60 s SEV-3 / >5 min SEV-2 / >30 min SEV-1**. M33's 10-min warn sits between SEV-3 and SEV-2 — it degrades the reporting surface gracefully well before the SEV-2 page.
- **User-facing lag is rounded to the nearest minute** (no timing-oracle); admin surfaces see precise seconds.
- **Scrape:** `m33_replica_lag_seconds`, `m33_replica_lag_state{fresh|degraded|stale}`.

### C.2 MV-refresh failure handling

Three refresh tiers live in `materialized_view_metadata.refresh_strategy`: `nightly` (02:00 tenant-local cron), `incremental` (outbox-subscriber, 5-second debounce per MV), `on_demand` (Valkey 5-min TTL). All refreshes run `REFRESH MATERIALIZED VIEW CONCURRENTLY` on the **`report.mv_refresh`** BullMQ queue, keyed on `mv_key` (max one in-flight refresh per MV; redelivered events inside the debounce window do not re-refresh).

- **Backoff + retry:** a failed refresh retries with BullMQ backoff and increments `consecutive_failures`. **Alert gate: 3 consecutive non-critical failures OR 1 critical-tier failure** → **`m33.mv.refresh_exhausted`** → M36 **critical** alert to `report_admin` / `org_admin`. Success emits `m33.mv.refresh_succeeded` and resets the counter.
- **SLO:** per-MV refresh **p50 < 60 s / p95 < 300 s / p99 < 900 s** (900 s = alert threshold).
- **Admin manual refresh:** the console `/reports/admin/mvs` shows per-MV status with a **`Refresh now`** trigger (perm `report.admin.mv_refresh`, `platform_admin_scope`), **rate-limited 1/min**.
- **Scrape:** `m33_mv_refresh_total`, `m33_mv_consecutive_failures`.

### C.3 Scheduled-report failure triage

Scheduled runs (`report_schedule_run`: `queued → running → rendered_pending → rendered_complete → delivered → failed`) emit a render request to M22 and deliver via M36. Triage by typed `failed` reason:

| Reason | Meaning | Action |
|---|---|---|
| `STATEMENT_TIMEOUT` | Query exceeded the 300 s scheduled tier | Refine the definition's filters / row_limit; re-run. Sinks to `failed`. |
| `M22_RENDER_FAILED` | M22 render errored | Auto-retries **≤ 3**, then **auto-pauses** the schedule; investigate M22 health, then resume. |
| `RECIPIENT_LOST_ACCESS` | A recipient's access was revoked between schedule and send | **Non-fatal** — that recipient is dropped, the run still delivers to the rest (`recipient_count_after_revoke_check`). |
| `MV_REFRESH_LAG` | The backing MV last refreshed > 24 h ago | The run **proceeds on the last snapshot** with an `mvStale=true` footer; fix the underlying refresh failure (§C.2). |

**At-most-once** per `(schedule_id, scheduled_for)` (unique index) — a `failed` run never blocks the next scheduled run for the same schedule, and a redelivery cannot double-send.

### C.4 Chaos drills (§9.8)

- **Replica down** → fall back to primary with a 30 s timeout + banner; reporting stays read-only.
- **Refresh-worker-pool down** → manual `Refresh now` still works; freshness chips go red.
- **Primary failover** → reconnect < 30 s; in-flight scheduled runs retry on the next cron tick.

---

**End of CHARTWARDEN_OPS_RUNBOOK v0.1.**

<!-- verified-against: 6a6eb454a12a · 2026-08-14 -->
