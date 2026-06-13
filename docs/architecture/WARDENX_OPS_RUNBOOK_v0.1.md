# WardenX — Operations Runbook

**Document ID:** WARDENX_OPS_RUNBOOK
**Status:** v0.1
**Owner:** Fabrice V. Adjam (Engineering)
**Companion to:** WARDENX_ARCHITECTURE v0.9, WARDENX_SYSTEM_DESIGN v0.2, WARDENX_DR_BCP v0.1
**Review cadence:** Quarterly minimum; updated continuously as procedures evolve
**Last reviewed:** 2026-06-08

**Scope distinction:** This document covers **routine operations** and **degraded-but-not-broken** scenarios. Catastrophic scenarios (DB primary loss, ransomware, regional disaster) are in WARDENX_DR_BCP. The dividing line: if it's a SEV-1 in DR_BCP §2.3, look in DR_BCP first; if it's SEV-2/3/4 or planned work, look here.

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

- **Architectural reference** — see WARDENX_ARCHITECTURE
- **Runtime design** — see WARDENX_SYSTEM_DESIGN
- **Catastrophic incident response** — see WARDENX_DR_BCP
- **Security threat model** — see WARDENX_SECURITY_HARDENING
- **Vendor contract details** — see WARDENX_INTEGRATIONS
- **Module implementation specs** — see `docs/modules/<NN-name>/SPEC.md`

### 1.3 Conventions

- Commands shown for production unless explicitly marked DEV
- VM names use the convention in WARDENX_SYSTEM_DESIGN §2.2 (`wardenx-app-01`, `wardenx-db-01`, etc.)
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
| August | Policy review — every WardenX policy reviewed for currency | Compliance |
| October | Encryption key rotation (production data keys) | Engineering |
| December | Year-end audit log retention compliance verification | Compliance |
| Floating | SOC 2 audit (when sought — Phase 3) | External auditor |
| Floating | HITRUST audit (when sought — future) | External auditor |

---

## 4. Deployment Operations

### 4.1 Pre-Deploy Checklist

For every deploy, however small:

- [ ] Code merged to `main` (no direct deploys from branches)
- [ ] All CI checks green (lint, typecheck, unit, integration, RLS, e2e, SBOM)
- [ ] Container image signed with cosign
- [ ] Image SBOM attached
- [ ] Migration files reviewed (if present): forward-only? two-phase pattern if breaking?
- [ ] Feature flags: any new flags? Default values set? Documented in `docs/feature-flags/`?
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

# 2. Verify image signature and SBOM
cosign verify --certificate-identity=https://github.com/wardenx/wardenx-monorepo/.github/workflows/ci.yml@refs/heads/main \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  ghcr.io/wardenx/backend:<sha>

# 3. Pull image to all app VMs (parallel; doesn't impact running traffic)
for vm in wardenx-app-01 wardenx-app-02; do
  ssh $vm "docker pull ghcr.io/wardenx/backend:<sha>" &
done
wait

# 4. Start new (green) containers alongside existing (blue) on each app VM
for vm in wardenx-app-01 wardenx-app-02; do
  ssh $vm "docker run -d \
    --name wardenx-backend-green \
    --network wardenx \
    --env-file /etc/wardenx/.env \
    -p 4191:4181 \
    ghcr.io/wardenx/backend:<sha>"
done

# 5. Wait for health on green
for vm in wardenx-app-01 wardenx-app-02; do
  until curl -sf https://$vm:4191/ready; do
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
- [ ] `/version` returns expected new SHA
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
ssh wardenx-db-01 "sudo -u postgres pgbackrest --stanza=wardenx --type=incr --tag=pre-migration-<sha> backup"

# 3. Run migration against primary
# Drizzle migrations apply via init container before backend rollout
# In manual control mode:
DATABASE_URL=postgres://wardenx_admin:<pass>@wardenx-db-01/wardenx \
  bun --filter @wardenx/db drizzle:migrate

# 4. Verify migration applied
psql -h wardenx-db-01 -U postgres -d wardenx -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"

# 5. Deploy new backend (with code that dual-writes old + new columns if applicable)

# 6. Let dual-write run for ≥ 1 week to surface any issues

# 7. Backfill script if needed
DATABASE_URL=... bun packages/db/scripts/backfill-<feature>.ts
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

| Table | Partition by | Cadence | Retention |
|---|---|---|---|
| `audit_event` | RANGE created_at | Monthly | Per retention class (Architecture §24) |
| `claim` | LIST provider_entity_id then RANGE created_at | Quarterly | 7 years |
| `claim_line` | Co-partitioned with claim | Quarterly | 7 years |
| `encounter` | LIST organization_id then RANGE created_at | Quarterly | Per state retention |
| `encounter_note` | Co-partitioned with encounter | Quarterly | Per state retention |
| `hope_assessment` | LIST organization_id then RANGE created_at | Annually | 6 years |
| `message` | LIST organization_id then RANGE created_at | Monthly | 6 years |
| `extraction_job` | RANGE created_at | Monthly | 30 days |
| `feature_flag_evaluation` | RANGE evaluated_at | Monthly | Per flag kind (varies) |

#### 5.2.2 Partition Rotation Job

A weekly BullMQ job (`partition.rotate`) verifies that next-3-months of partitions exist for all partitioned tables. If missing, creates them.

```typescript
// packages/db/src/jobs/partition-rotation.ts
export async function rotatePartitions(db: typeof DbClient) {
  const now = new Date()
  for (let i = 0; i < 3; i++) {
    const month = startOfMonth(addMonths(now, i + 1))
    await db.execute(sql`SELECT create_audit_partition(${month}::date)`)
    await db.execute(sql`SELECT create_message_partition(${month}::date)`)
    await db.execute(sql`SELECT create_outbox_partition(${month}::date)`)
    // ... etc per table
  }
}
```

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
| `DATABASE_URL` (wardenx_app) | Backend, workers | Annual | YYYY-MM-DD | YYYY-MM-DD |
| `DATABASE_URL` (wardenx_admin) | Migrations only | Annual | | |
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
psql -h wardenx-db-01 -U postgres -c "ALTER ROLE wardenx_app PASSWORD '$NEW_PASS';"

# 3. Update PgBouncer userlist
ssh wardenx-app-01 "sudo bash -c 'echo \"wardenx_app=$NEW_PASS\" >> /etc/pgbouncer/userlist.txt'"
ssh wardenx-app-02 "sudo bash -c 'echo \"wardenx_app=$NEW_PASS\" >> /etc/pgbouncer/userlist.txt'"

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
sudo -u postgres pgbackrest --stanza=wardenx-v2 --repo1-cipher-pass=$NEW_PASS stanza-create

# 4. Take fresh full backup under new stanza
sudo -u postgres pgbackrest --stanza=wardenx-v2 --type=full backup

# 5. Verify backup is good
sudo -u postgres pgbackrest --stanza=wardenx-v2 --type=full verify

# 6. Update postgresql.conf to use new stanza for archive-push
# 7. Cut over backup scheduling to wardenx-v2
# 8. Retain old stanza wardenx for historical backup restoration only
# 9. After 6 months (per retention class), retire old stanza
```

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

- One break-glass `wardenx_admin` PostgreSQL credential, password sealed in offline envelope
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

Monthly review consolidates into a vendor-spend report stored in `docs/ops/cost-reports/<YYYY-MM>.md`.

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

```bash
# 1. Create Organization record
# (Via admin console or scripted via packages/db/scripts/create-tenant.ts)
bun packages/db/scripts/create-tenant.ts \
  --slug=<slug> \
  --legal-name="<Legal Name>" \
  --display-name="<Display>"

# 2. Create ProviderEntity (CCN)
bun packages/db/scripts/create-provider-entity.ts \
  --org-slug=<slug> \
  --ccn=<6-digit> \
  --npi=<10-digit> \
  --fiscal-intermediary=<MAC-code> \
  --fye=<MMDD>

# 3. Create initial Locations
# (per setup data)

# 4. Provision MinIO buckets (§6.6)

# 5. Create initial admin user
bun packages/db/scripts/create-user.ts \
  --email=<admin@tenant.com> \
  --name="<Admin Name>" \
  --send-invitation

# 6. Attach admin user as Membership with org_admin role

# 7. Configure tenant settings
bun packages/db/scripts/set-tenant-settings.ts \
  --org-slug=<slug> \
  --setting timezone=America/Los_Angeles \
  --setting default-language=en-US

# 8. Set initial feature flags
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
# Procedure
bun packages/db/scripts/suspend-tenant.ts \
  --org-slug=<slug> \
  --reason="<reason>" \
  --until=<date-optional>

# This sets organization.status = 'suspended'
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
bun packages/db/scripts/export-tenant-data.ts \
  --org-slug=<slug> \
  --output=/mnt/exports/<org>-final-export.tar.gz

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
# 4. WardenX assists with export generation if needed

bun packages/db/scripts/export-patient-records.ts \
  --org-slug=<slug> \
  --patient-id=<uuid> \
  --format=<pdf|fhir|json> \
  --output=/mnt/exports/<patient>-records.<ext>

# 5. Tenant delivers to patient per HIPAA timeline (30 days; one 30-day extension allowed)
# 6. Document fulfillment in audit log
```

### 11.5 Data Portability Requests

Patient requesting electronic copy in transferable format (HIPAA right):

```bash
# 1. Same identity verification as DSAR
# 2. Generate FHIR R4 bundle (preferred portable format)
bun packages/db/scripts/export-patient-records.ts \
  --org-slug=<slug> \
  --patient-id=<uuid> \
  --format=fhir-bundle \
  --output=/mnt/exports/<patient>-bundle.json

# 3. Deliver via secure channel
```

### 11.6 Compliance-Driven Data Holds

Legal hold (litigation, audit, investigation) per Architecture §24.3:

```bash
# 1. Compliance officer triggers
bun packages/db/scripts/apply-legal-hold.ts \
  --org-slug=<slug> \
  --scope="patient-id=<uuid>" \
  --reason="<docket>" \
  --release-conditional-on="<conditions>"

# 2. All matching records' retention_class flipped to 'legal_hold'
# 3. Retention jobs skip 'legal_hold' records
# 4. Audit event: data.legal_hold_applied
# 5. Documentation: hold notice retained in legal docs folder
```

---

## 12. Compliance Operations

### 12.1 Annual HIPAA Security Risk Analysis

Mandatory annually per HIPAA Security Rule §164.308(a)(1)(ii)(A). Scope:

- All ePHI created, received, maintained, transmitted by WardenX
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
- Re-signed by compliance officer + WardenX leadership
- Distributed to workforce (training updates)
- Filed in `docs/policies/<name>-vYYYY-MM.md`

### 12.6 Workforce Training

Annual training mandatory per §164.308(a)(5):

- HIPAA Privacy and Security Rule basics
- WardenX-specific policies
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
curl -w "@curl-timing.txt" -sf https://wardenx-app-01:4181/health

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
- wardenx_app: from backend VMs only, via PgBouncer, password-authenticated
- wardenx_replicator: from replica VM only, IP-restricted
- wardenx_readonly: from observability VM and explicit engineer connections, audit-logged
- wardenx_admin: from migration runner only OR break-glass; password sealed offline
- postgres (superuser): break-glass only
```

Database admin access (wardenx_admin or postgres role):

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

Every admin (wardenx_admin role, platform_ops user) action audited:

- Logged in audit_event
- Reviewed monthly by compliance officer
- Anomalies investigated

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
ssh wardenx-db-01 "sudo -u postgres pgbackrest --stanza=wardenx info"

# All VMs status
for vm in $(get_all_vms); do
  echo -n "$vm: "
  ssh $vm "uptime" 2>&1 | head -1
done
```

### A.3 Emergency Contacts

(Stored in `docs/ops/contacts.yaml`, encrypted via SOPS for sensitive entries)

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

**End of WARDENX_OPS_RUNBOOK v0.1.**
