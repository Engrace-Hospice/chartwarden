# WardenX — Disaster Recovery & Business Continuity Plan

**Document ID:** WARDENX_DR_BCP
**Status:** v0.1
**Owner:** Fabrice V. Adjam (Engineering + Compliance — currently single accountable owner; roles split as team grows)
**Companion to:** WARDENX_ARCHITECTURE v0.9, WARDENX_SYSTEM_DESIGN v0.2
**Review cadence:** Annual minimum; ad-hoc on architecture changes, vendor changes, or post-incident
**Last reviewed:** 2026-06-08

**Audience:** Engineering on-call, compliance officer, customer-facing leads. Sections marked **[CLINICAL]** are written to inform clinical staff at customer agencies of expected behavior during WardenX outages.

---

## 1. Purpose & Scope

### 1.1 Purpose

This document defines how WardenX maintains availability, recovers from failure, and protects patient care continuity when normal operations are disrupted. It satisfies HIPAA Security Rule §164.308(a)(7) Contingency Plan and serves as the operational complement to the architectural disaster-resilience patterns documented in System Design §10.

It is also the source-of-truth document for the obligations WardenX makes to customer hospice agencies regarding system availability and recovery. Service-level commitments referenced in customer agreements reference this document by version.

### 1.2 Scope — In

- WardenX production infrastructure (initial: Proxmox cluster; future: cloud)
- All WardenX-operated services: backend, workers, PostgreSQL, Valkey, MinIO, MLflow, observability
- Backups, replication, restoration procedures
- Vendor outages (Anthropic, DoseSpot, Twilio, Postmark, Stripe, MAC portals, Medicaid portals, Xero, Gusto) where they impact WardenX customer operations
- Business continuity guidance to customer hospice agencies during WardenX outage
- HIPAA breach notification triggers and procedures

### 1.3 Scope — Out (or owned elsewhere)

- Customer agencies' own internal IT continuity (their network, their workstations, their staff phones) — but WardenX coordinates where joint
- Customer agencies' own paper fallback procedures (WardenX provides forms and guidance; agency executes)
- WardenX corporate office continuity (separate document; not patient-facing)
- Long-term archival strategy beyond compliance retention (covered in Architecture §24 Data Retention Matrix)

### 1.4 Relationship to Other Documents

| Document | Relationship |
|---|---|
| WARDENX_ARCHITECTURE v0.9 §24 Data Retention | Defines what must be preserved during recovery; this doc defines how |
| WARDENX_SYSTEM_DESIGN v0.2 §10 Failure Modes | High-level failure-mode behaviors; this doc operationalizes |
| WARDENX_OPS_RUNBOOK | Step-by-step routine ops (deploys, migrations); shares some content with this doc |
| WARDENX_SECURITY_HARDENING | Defines threat model; this doc handles realized threats |
| HIPAA Security Policies | Higher-level policy; this doc is implementation |

---

## 2. Governance & Roles

### 2.1 Incident Response Structure

WardenX uses ICS (Incident Command System)-style role definitions. **At current solo-developer phase, multiple roles converge to Fabrice; this is an acknowledged single-point-of-failure risk.** Backup contact and contracted relief required before WardenX has more than 3 customer tenants.

| Role | Responsibilities | Current Owner | Required Backup |
|---|---|---|---|
| **Incident Commander (IC)** | Declares incident, sets priorities, owns all decisions during incident, communicates with customers | Fabrice | TBD (contract on-call relief by tenant #3) |
| **Technical Lead** | Executes recovery procedures, owns technical decisions, runs runbooks | Fabrice | TBD |
| **Communications Lead** | Status page updates, customer notifications, vendor escalations | Fabrice | TBD |
| **Compliance Officer** | HIPAA breach notification assessment, regulatory communications, audit trail preservation | Fabrice (interim); contracted compliance counsel before first customer | Contracted counsel |
| **Customer Liaison (per agency)** | Each customer agency designates one staff member as their primary point of contact during incidents; their backup is identified in their tenant settings | Customer-owned | Customer-owned |

### 2.2 On-Call Schedule

| Phase | Coverage |
|---|---|
| Engrace only (current) | Fabrice 24/7, with explicit blackout periods documented in advance (e.g., scheduled time off → automated read-only degraded mode prepared in advance) |
| 2-3 customer tenants | Fabrice + contracted on-call relief (8 PM - 8 AM coverage minimum) |
| 4+ tenants or first enterprise contract | Formal on-call rotation with at least 2 engineers |

### 2.3 Severity Classification

Incidents are classified at declaration and may be reclassified as conditions change. Classification drives response time, communication cadence, and post-incident review requirements.

| Severity | Definition | Examples | Response Time | Comms Cadence |
|---|---|---|---|---|
| **SEV-1** | Patient care impacted; data loss; PHI exposure; total outage | DB primary failed; ransomware detected; PHI exposed in error; all backends down | IC engaged within 5 min; tech lead within 15 min | Initial status within 15 min; updates every 30 min until resolved |
| **SEV-2** | Significant degradation; partial outage; single critical feature unavailable | DoseSpot outage; one backend instance crashed; intermittent errors >5% | IC engaged within 15 min | Initial status within 30 min; updates every 1 hr |
| **SEV-3** | Minor degradation; workarounds available; single non-critical feature affected | Reporting slow; one Python worker failing; degraded AI features | IC engaged within 1 hr (business hours) or 8 AM next day (off-hours) | Updates every 4 hr |
| **SEV-4** | No customer impact; internal observability concern | Disk usage approaching threshold; non-prod alerting; backup verification soft failure | Next business day | Internal only |

### 2.4 Authority Matrix

| Decision | SEV-1 | SEV-2 | SEV-3 | SEV-4 |
|---|---|---|---|---|
| Activate kill switch | IC | IC or Tech Lead | Tech Lead | Tech Lead |
| Failover to DR site | IC | IC | N/A | N/A |
| Notify customers | Comms Lead under IC direction | Comms Lead | Tech Lead | None |
| Notify regulators (HIPAA breach) | Compliance Officer (after IC + counsel review) | Compliance Officer if PHI exposure | None | None |
| Restore from backup | IC approval; Tech Lead executes | Tech Lead | Tech Lead | Tech Lead |
| Engage external vendor escalation | IC or Tech Lead | Tech Lead | Tech Lead | Tech Lead |
| Engage outside counsel | IC | IC | None | None |
| Engage forensic firm (suspected breach) | IC + counsel | IC + counsel | None | None |

---

## 3. Recovery Objectives

### 3.1 Service Tiers

Services classified by patient-care criticality. Tier determines RTO/RPO targets and resource allocation during incidents.

| Tier | Definition | Services | RTO Target | RPO Target |
|---|---|---|---|---|
| **Tier 1 — Critical patient care** | Loss directly affects active patient care, medication administration, or imminent safety | Backend API (encounter save, eMAR, orders), PostgreSQL primary read+write, Valkey (session), Socket.IO (real-time alerts), Module 18 EVV, Module 19 On-Call | **1 hour** | **5 minutes** |
| **Tier 2 — Clinical operations** | Loss impedes clinical workflow but doesn't immediately threaten patient safety | HearthNote Layer 1, HOPE Engine, IDG, Care Plan, Documents, FHIR Gateway read | **4 hours** | **15 minutes** |
| **Tier 3 — Revenue & Reporting** | Loss impedes billing/reporting but not clinical care | Module 23 (Billing-Medicare), Module 24 (Billing-Medicaid), Module 25 (Remittance), Module 33 (Reporting), Module 30 (HQRP) | **24 hours** | **1 hour** |
| **Tier 4 — Augmenting & Optional** | Nice-to-have; gracefully degrades | HearthNote Layer 2 (LLM), DocLens, AI predictions, Telehealth, ML training | **72 hours** | **24 hours** |
| **Tier 5 — Cold archival** | Historical data accessed rarely | Archived audit partitions, retired ML models, archived intake artifacts | **1 week** | **24 hours** |

### 3.2 Tier Mapping Rationale

**Why eMAR is Tier 1 but Billing is Tier 3:** A delay administering scheduled morphine is a patient safety event. A delay submitting a 837I file by 24 hours is a cash-flow event but the claim still pays. The system prioritizes the former in recovery sequencing.

**Why HOPE is Tier 2 but HIS-submission is Tier 3:** Documenting symptom impact at the visit (HOPE Engine in Module 10) must continue (Tier 2). Submitting the data to CMS in batch (Tier 3) can wait 24 hours without regulatory consequence.

**Why telehealth is Tier 4:** Telehealth visits can be rescheduled or conducted by phone if the platform is down. Loss is inconvenient but not safety-critical.

### 3.3 Recovery Time Tracking

Every incident records actual RTO and RPO achieved. Post-incident review compares actuals to targets. Trend of actuals informs:

- Whether tier targets need adjustment
- Whether infrastructure investment is needed (e.g., adding read replica reduces effective RTO)
- Whether procedures need optimization

### 3.4 Customer SLA vs Internal Target

Internal RTO/RPO targets are typically tighter than what is committed to customers in service agreements. This allows for variance without breaching contract.

| Tier | Internal Target | Customer SLA |
|---|---|---|
| Tier 1 | 1 hr RTO / 5 min RPO | 2 hr RTO / 15 min RPO |
| Tier 2 | 4 hr RTO / 15 min RPO | 8 hr RTO / 1 hr RPO |
| Tier 3 | 24 hr RTO / 1 hr RPO | 48 hr RTO / 4 hr RPO |
| Tier 4 | 72 hr RTO / 24 hr RPO | No SLA |

---

## 4. Backup Architecture

### 4.1 PostgreSQL Backups (pgBackRest)

#### 4.1.1 Stanza Configuration

```ini
# /etc/pgbackrest/pgbackrest.conf on wardenx-db-01 and wardenx-db-02
[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=14
repo1-retention-diff=7
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<sealed in SOPS>
repo1-bundle=y
log-level-console=info
log-level-file=detail
process-max=4
compress-type=zstd
compress-level=3
start-fast=y

# Secondary repository on backup VM
repo2-host=wardenx-backup-01
repo2-host-user=pgbackrest
repo2-path=/var/lib/pgbackrest
repo2-retention-full=30
repo2-retention-diff=14
repo2-cipher-type=aes-256-cbc
repo2-cipher-pass=<different sealed key>

# Off-site repository (encrypted S3-compatible target)
repo3-type=s3
repo3-s3-endpoint=<off-site MinIO>
repo3-s3-bucket=wardenx-pg-backup
repo3-s3-region=us-west
repo3-path=/wardenx
repo3-cipher-type=aes-256-cbc
repo3-cipher-pass=<third sealed key>
repo3-retention-full=90
repo3-retention-diff=30

[wardenx]
pg1-path=/var/lib/postgresql/18/main
pg1-port=5432
pg1-host-user=postgres
recovery-option=recovery_target_action=promote
```

#### 4.1.2 Backup Schedule

| Type | Frequency | Retention | Repository |
|---|---|---|---|
| Full backup | Sunday 02:00 UTC | 14 backups (local), 30 (backup VM), 90 (off-site) | repo1, repo2, repo3 |
| Differential backup | Wednesday 02:00 UTC | 7 (local), 14 (backup VM), 30 (off-site) | repo1, repo2, repo3 |
| Incremental backup | Daily 02:00 UTC except Sun/Wed | 6 (local), 13 (backup VM), 29 (off-site) | repo1, repo2, repo3 |
| WAL archiving | Continuous (every WAL segment) | 14 days local, 30 days backup VM, 90 days off-site | repo1, repo2, repo3 |

**Resulting recovery granularity:** Any point in time within the last 14 days at full granularity; daily snapshots up to 90 days off-site.

#### 4.1.3 WAL Archiving Configuration

```ini
# postgresql.conf
archive_mode = on
archive_command = 'pgbackrest --stanza=wardenx archive-push %p'
archive_timeout = 60s  # Force WAL switch every 60s if low activity (caps RPO at 60s)
```

#### 4.1.4 Backup Verification

Every backup is verified within 1 hour of completion:

- pgBackRest itself runs verify on each backup (checksum validation)
- A cron-driven test job runs `pgbackrest --stanza=wardenx info` and parses output; any backup not present or marked invalid → SEV-3 alert
- Monthly: full restore-to-sandbox drill (§9.1)

### 4.2 MinIO Backups

#### 4.2.1 Per-Bucket Strategy

| Bucket prefix | Versioning | Object Lock | Replication target |
|---|---|---|---|
| `tenants/<org>/documents/` | Enabled | None | wardenx-backup-01 (real-time async) + off-site weekly |
| `tenants/<org>/generated/` | Enabled | None | wardenx-backup-01 weekly |
| `tenants/<org>/intake/` | Disabled (ephemeral) | None | None — 30-day lifecycle |
| `tenants/<org>/claims/` | Enabled | Compliance, 7 years | wardenx-backup-01 (real-time) + off-site daily |
| `tenants/<org>/cost-reports/` | Enabled | Compliance, 7 years | wardenx-backup-01 (real-time) + off-site daily |
| `tenants/<org>/exports/` | Enabled | None | wardenx-backup-01 weekly |
| `tenants/<org>/recordings/` | Enabled | Per-consent terms | wardenx-backup-01 daily |
| `platform/form-templates/` | Enabled | None | wardenx-backup-01 daily + off-site weekly |
| `platform/ml-models/` | Enabled | None | wardenx-backup-01 daily + off-site monthly |

#### 4.2.2 MinIO Replication Configuration

Site replication (active-active for redundancy) between primary and backup MinIO:

```bash
# Configure replication from primary to backup
mc replicate add wardenx-primary/tenants \
  --remote-bucket wardenx-backup/tenants \
  --priority 1 \
  --replicate "delete,delete-marker,replica-metadata-sync"

# Verify replication health daily
mc replicate status wardenx-primary/tenants
```

#### 4.2.3 Off-Site Replication

Off-site target (initially TBD per ADR-002) receives:
- Daily incremental replication of `claims/` and `cost-reports/` (compliance-critical, low volume)
- Weekly full replication of `documents/`
- Monthly full replication of `platform/`

### 4.3 Valkey Backups

Valkey is **not the system of record** — all critical data is in PostgreSQL. Valkey holds:
- Sessions (loss → re-login required for active users)
- Cache (loss → cold-start performance impact)
- BullMQ queues (loss → jobs may be re-executed; idempotency required)
- Socket.IO adapter pub/sub (ephemeral by design)

Backup strategy:

```ini
# valkey.conf
appendonly yes
appendfsync everysec
dir /var/lib/valkey
save 900 1
save 300 10
save 60 10000
```

- AOF persistence with `everysec` (worst case 1 sec data loss on crash)
- Snapshot every 15 min copied to backup VM
- AOF rewrite daily during low-traffic window

**Recovery from Valkey loss:** Restore from latest snapshot. Active users force re-login. In-flight BullMQ jobs may re-execute (consumers must be idempotent — verified in Module 1 test suite).

### 4.4 Application State

| Asset | Storage | Backup |
|---|---|---|
| Container images | GHCR (GitHub Container Registry) | GHCR retains by tag; we also pull-and-archive monthly snapshots to backup VM |
| Source code | GitHub (primary) + weekly mirror to wardenx-backup-01 | Git is itself a distributed backup; mirror provides off-platform redundancy |
| Build artifacts | GitHub Actions cache + GHCR | Re-buildable from source; not separately backed up |
| Secrets (SOPS-encrypted) | In Git (encrypted) | Inherits Git backup; age keys held offline in two locations |
| Configurations | In Git + on each VM | Configs are immutable per deploy; backups via Proxmox VM snapshots |

### 4.5 Proxmox VM Backups

Weekly full VM backups to wardenx-backup-01 via Proxmox Backup Server (PBS):

| VM | Backup frequency | Retention |
|---|---|---|
| All app/worker VMs | Weekly | 4 weeks |
| Database VMs (db-01, db-02) | Daily VM snapshot (in addition to pgBackRest) | 7 daily, 4 weekly |
| MinIO VM (storage-01) | Weekly | 4 weeks (data is bucket-replicated separately) |
| Backup VM (backup-01) | Snapshot mirrored to off-site monthly | 3 months |
| Edge, Obs VMs | Weekly | 4 weeks |

**VM-level backups exist for fast bare-metal recovery; PostgreSQL pgBackRest and MinIO replication are the authoritative data backups.**

### 4.6 Backup Encryption

All backups are encrypted at rest:

- pgBackRest: AES-256-CBC with stanza-specific keys
- MinIO replication: TLS in transit; objects encrypted server-side with KMS-managed keys (or AES-256 with locally-managed keys initially)
- Proxmox PBS: native encryption with site key
- Off-site: separate key not held on production hosts

**Key management:**

- Three keys per encryption boundary (primary, backup, off-site) so compromise of one doesn't compromise all backups
- Keys held in SOPS-encrypted form in Git plus offline in a sealed envelope in fire safe
- Annual key rotation; old keys retained for re-decryption of older backups (per data retention matrix Architecture §24.5)
- Key destruction follows destruction certification workflow (Architecture §24.2)

### 4.7 Backup Restoration Smoke Tests

Each backup type has a verification procedure run on schedule:

| Backup type | Test frequency | What's verified |
|---|---|---|
| pgBackRest backup | Daily (automated) | Backup integrity, retention policy applied, repo healthy |
| pgBackRest restore | Monthly (manual + automated) | Full restore to sandbox VM; checksum compare; smoke queries run |
| MinIO replication | Continuous (MinIO status) | Replication lag < 1 min; object count matches |
| MinIO object restore | Monthly | Random sample of 100 objects pulled from backup; bit-identical to primary |
| Proxmox VM backup | Monthly | Random VM restored to alternate Proxmox node; boots cleanly |
| Off-site restore | Quarterly | Full PG restore from off-site repo to sandbox; full procedure timed |
| Secret decryption | Quarterly | Verify off-site age keys still decrypt SOPS-encrypted secrets |

---

## 5. Replication Architecture

### 5.1 PostgreSQL Streaming Replication

Primary (wardenx-db-01) → Replica (wardenx-db-02):

```conf
# wardenx-db-01 postgresql.conf
wal_level = replica
max_wal_senders = 5
max_replication_slots = 5
wal_keep_size = 1GB
synchronous_standby_names = ''  # async replication; sync optional with performance trade

# wardenx-db-01 pg_hba.conf
host replication wardenx_replicator 10.10.30.12/32 scram-sha-256

# wardenx-db-02 (standby)
primary_conninfo = 'host=wardenx-db-01 port=5432 user=wardenx_replicator password=<sealed> application_name=db-02'
primary_slot_name = 'standby_db_02'
restore_command = 'pgbackrest --stanza=wardenx archive-get %f %p'
```

**Asynchronous replication trade-off:** Allows replica to lag slightly (<1 sec typical, <30 sec worst case during heavy write spikes) without slowing the primary. Acceptable for hospice EHR — losing 30 sec of writes in a failover is a known cost.

**Monitoring:**
- Prometheus alerts: replication lag > 60 sec (SEV-3), > 5 min (SEV-2), > 30 min (SEV-1 — replication broken)
- Replication slot age monitored — slots not consumed will fill WAL and crash primary if left unattended

### 5.2 MinIO Active-Active Replication

Bucket-level replication between primary MinIO (wardenx-storage-01) and backup MinIO (wardenx-backup-01) using MinIO's built-in async replication:

- **RPO from MinIO replication:** typically < 30 sec; worst-case minutes during heavy upload
- **Recovery path:** if primary MinIO is down, applications can be reconfigured to read from backup (write-through behavior validated in DR drill)

### 5.3 What Is NOT Replicated

Some state intentionally not replicated to keep complexity bounded:

- **Valkey:** session/cache/queue are ephemeral; rebuilt on recovery
- **Prometheus / Loki / Tempo:** observability data; loss is acceptable
- **MLflow run metadata:** can be rebuilt from training jobs if needed (model artifacts are backed up)

---

## 6. Failover Procedures

### 6.1 PostgreSQL Primary → Replica Promotion

**Trigger conditions** (any of):
- Primary unresponsive for > 5 min with no recovery sign
- Primary disk failure detected
- Primary VM corrupted beyond easy recovery
- Network partition isolating primary

**Procedure** (target time: 15 minutes from decision to running):

```bash
# Step 1: Verify replica state on wardenx-db-02
psql -h wardenx-db-02 -U postgres -c "SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"
# If these differ significantly, replica is behind — consider RPO impact

# Step 2: Halt writes to primary (if reachable)
# Disable pg_hba.conf for wardenx_app role on primary, OR shut down primary entirely

# Step 3: Promote replica
sudo -u postgres pg_ctl promote -D /var/lib/postgresql/18/main

# Step 4: Verify replica is now primary
psql -h wardenx-db-02 -U postgres -c "SELECT pg_is_in_recovery();"
# Expect: false

# Step 5: Update application configuration
# Update PgBouncer config or DNS or load balancer to point to new primary
# Method depends on infrastructure setup; see §6.1.1

# Step 6: Restart backend instances (rolling)
for vm in wardenx-app-01 wardenx-app-02; do
  ssh $vm "sudo systemctl restart wardenx-backend"
  sleep 30
  curl -sf https://$vm:4181/ready || echo "FAIL on $vm"
done

# Step 7: Verify writes succeed
# Run smoke test endpoint that creates a test audit event

# Step 8: Re-establish a new replica
# This is the longer-running task; new primary is operational without replica during this window
# See §6.1.2
```

#### 6.1.1 Application Reconfiguration Methods

Three approaches, in order of preference:

**Method A — PgBouncer host swap (preferred):**
- PgBouncer config has both hosts defined; on failover, edit `/etc/pgbouncer/pgbouncer.ini` to swap `host=` value, run `RELOAD` command
- Application unaware; connections pick up on next checkout

**Method B — DNS-based:**
- Internal DNS record `db-primary.wardenx.internal` updates to point to new primary
- TTL 30 sec; takes up to 30 sec to propagate
- Application connection pool drops stale connections, reconnects to new target

**Method C — Application config reload:**
- Application reads DB host from a config file or environment variable
- Update via Ansible or systemd; rolling restart

#### 6.1.2 Establishing New Replica

After promotion, the old primary (if recoverable) becomes the new replica, OR a fresh replica is built. Procedure:

```bash
# On old primary (or fresh VM):
# 1. Stop PostgreSQL
sudo systemctl stop postgresql

# 2. Wipe data directory
sudo rm -rf /var/lib/postgresql/18/main/*

# 3. Restore from new primary using pgBackRest
sudo -u postgres pgbackrest --stanza=wardenx --type=standby \
  --recovery-option=primary_conninfo='host=wardenx-db-02 user=wardenx_replicator' restore

# 4. Start in standby mode
sudo systemctl start postgresql

# 5. Verify replication starts
psql -U postgres -c "SELECT pg_is_in_recovery();"  # Expect: true
psql -U postgres -c "SELECT * FROM pg_stat_wal_receiver;"  # Expect: streaming
```

**Total time for fresh replica:** ~2-4 hours for typical database size (depends on data volume and disk speed). System is operational throughout but without failover redundancy until complete.

### 6.2 Valkey Failure Recovery

**Symptoms:** Connection failures from backend; Socket.IO disconnections; BullMQ jobs stalling.

**Procedure** (target time: 10 minutes):

```bash
# Step 1: Check Valkey health
redis-cli -h wardenx-data-01 PING
# If no response, escalate to recovery

# Step 2: Inspect Valkey logs
ssh wardenx-data-01 "tail -200 /var/log/valkey/valkey.log"
# Identify cause: OOM, disk full, configuration error, etc.

# Step 3: If salvageable, fix and restart
# Common: clear oversized AOF, fix config, free disk, restart
sudo systemctl restart valkey

# Step 4: If unsalvageable, fail over to standby (if configured) OR rebuild from snapshot
# Currently: single Valkey instance; rebuild from snapshot on backup VM
scp wardenx-backup-01:/var/backups/valkey/latest.rdb /var/lib/valkey/dump.rdb
sudo systemctl start valkey

# Step 5: Force all backend instances to reconnect
for vm in wardenx-app-01 wardenx-app-02; do
  ssh $vm "sudo systemctl restart wardenx-backend"
done

# Step 6: Active users will need to re-login (session loss accepted)
# Status page updated with notice
```

**Data loss expectation:** Up to 15 min depending on snapshot age + AOF replay.

**Future improvement (post-Phase 1):** Valkey Sentinel or Redis Cluster for HA. Current setup accepts single Valkey instance risk because Valkey state is ephemeral by design.

### 6.3 MinIO Failover

**Symptoms:** Object upload/download failures from backend; document UI shows errors; PDF generation queues backing up.

**Procedure** (target time: 20 minutes):

```bash
# Step 1: Verify primary MinIO is down
mc admin info wardenx-primary
# If unreachable, proceed to failover

# Step 2: Check backup MinIO health and replication lag
mc admin info wardenx-backup
mc replicate status wardenx-primary/tenants  # Check lag at last successful sync

# Step 3: Decide on data loss tolerance
# If replication was lagging significantly (>5 min), document RPO impact

# Step 4: Reconfigure applications to point to backup MinIO
# Update Vault/SOPS secrets with new endpoint
# Rolling restart of backend instances and workers
for service in wardenx-backend wardenx-worker-billing wardenx-worker-intake; do
  for vm in $(get_vms_for $service); do
    ssh $vm "sudo systemctl restart $service"
    sleep 30
  done
done

# Step 5: Verify backend can read/write to backup MinIO
curl -sf https://wardenx-app-01:4181/api/v1/admin/storage/health

# Step 6: Plan recovery of primary MinIO
# If hardware failure, replace and restore from backup
# Replication will resync once primary returns
```

**Data loss expectation:** Up to 1 hour for documents (Tier 2); near-zero for claims/cost-reports due to real-time replication.

### 6.4 Backend Instance Loss

**Symptoms:** Health check failures; load balancer routes traffic to remaining instances; one VM unreachable.

**Procedure** (mostly automated; manual intervention < 5 min):

1. Load balancer (Pangolin) detects failure via health check, removes from rotation automatically — no manual action needed for client traffic
2. SEV-3 alert fires to Tech Lead
3. Investigate: VM crashed? Process OOM? Disk full? Network?
4. Common fixes: restart VM, restart service, clear disk, restart Proxmox host if VM stuck
5. Once VM recovers, health check passes, load balancer re-adds to rotation
6. If VM unrecoverable, deploy new VM from template (Proxmox; ~10 min from template) + run deployment role

**Data loss expectation:** None (stateless backend).

### 6.5 Edge (Pangolin) Failure

**Symptoms:** Customers cannot reach any WardenX endpoint; DNS may resolve but TLS handshake fails or timeout.

**Procedure** (target time: 30 minutes):

This is the highest-impact failure short of total site loss. Backends are healthy but unreachable.

1. Verify edge VM state
2. If recoverable, restart Pangolin process; verify TLS cert valid, upstream config intact
3. If VM unrecoverable, deploy fresh edge VM from template, restore Pangolin config from Git, restore Let's Encrypt certs from sealed backup
4. Update DNS if edge IP changed (TTL 60 sec for edge records)

**Mitigation:** Run two edge VMs in active-passive (current setup is one VM — accepted risk for Engrace-only phase; upgrade before multi-tenant launch).

### 6.6 Network or VLAN Failure

**Symptoms:** Backend instances cannot reach DB or Valkey; clients can reach edge but everything beyond returns 503.

**Procedure** (target time: 15-60 minutes; varies by cause):

1. Determine scope: single VLAN down? Single switch port? Whole Proxmox internal network?
2. If switch/port: physical inspection or remote port reset
3. If VLAN config corrupted: restore from Proxmox network config backup (held in Git)
4. If Proxmox cluster networking broken: emergency procedures per Proxmox documentation; may require physical access
5. While network broken, all clinical operations on paper (see §11 Business Continuity)

### 6.7 Total Site (Datacenter / Proxmox Cluster) Failure

**Trigger conditions:**
- Fire, flood, theft, prolonged power outage at hosting site
- Hardware catastrophe affecting all Proxmox nodes
- Ransomware affecting hypervisor

**Procedure** — this is the regional disaster scenario covered in detail in §10.

---

## 7. Recovery Procedures

### 7.1 Point-in-Time Recovery (PostgreSQL)

Used when: data corruption detected, accidental destructive query, ransomware recovery.

**Decide target time:** Choose a timestamp **just before** the corruption event.

**Procedure** (target time: 1-4 hours depending on backup age and DB size):

```bash
# Step 1: Stop all writes to PG
# Disable wardenx_app role; halt backend services
for vm in wardenx-app-01 wardenx-app-02; do
  ssh $vm "sudo systemctl stop wardenx-backend"
done

# Step 2: Take final snapshot of current (corrupted) state for forensic preservation
# Even if you're going to restore over it, you want the corruption preserved
sudo -u postgres pgbackrest --stanza=wardenx --type=full --tag=pre-recovery-forensic backup

# Step 3: Restore to fresh data directory targeting specific time
sudo systemctl stop postgresql
sudo mv /var/lib/postgresql/18/main /var/lib/postgresql/18/main.corrupted
sudo -u postgres pgbackrest --stanza=wardenx --type=time \
  --target='2026-06-08 14:30:00' \
  --target-action=promote \
  --delta restore

# Step 4: Start PostgreSQL
sudo systemctl start postgresql

# Step 5: Verify state
psql -U postgres -c "SELECT MAX(created_at) FROM audit_event;"
# Should be just before target time

# Step 6: Replication needs rebuild (different timeline)
# See §6.1.2

# Step 7: Restart backend
# Step 8: Notify customers of any data loss between corruption point and recovery point
```

### 7.2 Object Storage Recovery from Backup

Used when: object accidentally deleted, bucket corruption, ransomware encryption.

**Object versioning** (enabled on all PHI buckets) is the first line of defense — deleted objects retrievable via:

```bash
mc cp --version-id <version> wardenx-primary/tenants/<org>/documents/<key> /tmp/recovered.pdf
```

If versioning insufficient (whole bucket lost):

```bash
# Restore from backup MinIO
mc mirror wardenx-backup/tenants/<org>/documents/ wardenx-primary/tenants/<org>/documents/
```

If both primary and backup affected (e.g., ransomware encrypted both, which shouldn't happen with proper segmentation):

```bash
# Restore from off-site target
# Procedure varies by off-site provider
```

### 7.3 Full Bare-Metal Recovery (Proxmox VM)

Used when: VM corrupted, lost, or needs to move to new hardware.

```bash
# Step 1: Identify backup
# Proxmox Backup Server UI shows backups for each VM

# Step 2: Provision new VM (if hardware available)
# Or clear corrupted VM if reusing

# Step 3: Restore from PBS
# Via Proxmox UI: Backups → Restore → Choose backup → Choose target node

# Step 4: Verify boot
# Login, check services, run health endpoint

# Step 5: Reconnect to cluster
# Update DNS / load balancer / Pangolin upstream if VM IP changed
```

**Typical restore time:** 15-30 min per VM depending on size.

### 7.4 Application Stack Rebuild

If all VMs lost but data backups intact:

1. Reprovision Proxmox cluster (or alternate hypervisor)
2. Restore VM images from PBS or rebuild from Ansible/Terraform (if used)
3. Restore PostgreSQL from pgBackRest (§7.1 procedure)
4. Restore MinIO buckets from backup target
5. Pull latest container images from GHCR (or backup mirror if GHCR unreachable)
6. Decrypt secrets from SOPS using off-site age keys
7. Bring services up in dependency order: PG → Valkey → MinIO → Backend → Workers → Edge
8. Run full smoke test suite
9. Restore customer traffic via DNS

**Total time:** 6-12 hours assuming hardware available.

### 7.5 Post-Recovery Verification Checklist

After any recovery, before resuming customer traffic:

- [ ] All services pass `/ready` health check
- [ ] Database connections succeed from all backend instances
- [ ] RLS isolation test (cross-tenant denial) passes
- [ ] Audit event insert succeeds and reads back correctly
- [ ] Outbox dispatcher running, queue depth normal
- [ ] BullMQ workers connected, no stuck jobs
- [ ] Socket.IO accepts connections, can join rooms
- [ ] MinIO upload + download succeed for a test object per tenant
- [ ] DoseSpot health endpoint reachable
- [ ] Anthropic test call succeeds
- [ ] Twilio test SMS to Fabrice succeeds
- [ ] Sample claim validation runs successfully through Module 23 pipeline
- [ ] Sample encounter save succeeds end-to-end including audit log entry
- [ ] Recent backup completes successfully (don't resume without proving new data is being backed up)
- [ ] Monitoring/alerting reports operational
- [ ] No SEV-1 or SEV-2 alerts open
- [ ] Status page updated to operational

---

## 8. Backup Verification & Restore Drills

### 8.1 Continuous Verification

| Verification | Frequency | Method | Failure response |
|---|---|---|---|
| pgBackRest backup completes | Daily | pgBackRest exit code + `info` command | SEV-3 alert; investigate same day |
| WAL archiving keeping up | Continuous | Prometheus metric of WAL backlog | SEV-2 alert if backlog > 5 min |
| MinIO replication lag | Continuous | MinIO replication metrics | SEV-3 alert if lag > 5 min, SEV-2 if > 30 min |
| Valkey snapshot to backup | Every 15 min | File freshness check on backup VM | SEV-3 alert if no snapshot in 30 min |
| PBS VM backup completes | Weekly | PBS job status | SEV-3 alert |

### 8.2 Monthly Restore Drill

**Objective:** Verify backups can actually be restored, not just that backup jobs report success.

**Procedure** (first Saturday of each month, 2-hour window):

```bash
# 1. Provision sandbox VM (or use dedicated test VM)
# 2. Restore latest pgBackRest backup to sandbox
sudo -u postgres pgbackrest --stanza=wardenx --type=default \
  --pg1-path=/var/lib/postgresql-test/data restore

# 3. Start sandbox PostgreSQL
# 4. Run validation queries:
psql -d wardenx -c "SELECT COUNT(*) FROM organization;"  # Expect: nonzero
psql -d wardenx -c "SELECT COUNT(*) FROM audit_event WHERE created_at > NOW() - INTERVAL '1 day';"  # Expect: matches production

# 5. Run RLS smoke test from packages/db/test/restore-verify.test.ts
bun test:restore-verify

# 6. Compare data checksums for sample tables
# 7. Document drill results in docs/dr-drills/<date>.md
# 8. Destroy sandbox; certificate that destruction occurred
```

**Drill output template:**

```markdown
# DR Drill — Monthly Restore — YYYY-MM-DD

**Conducted by:** Fabrice
**Backup tested:** Full backup of <date>
**Sandbox:** wardenx-sandbox-01 (Proxmox)

## Timing
- Restore start: HH:MM:SS
- Restore complete: HH:MM:SS
- Total: X minutes

## Verification Results
- [ ] Restore completed without error
- [ ] PostgreSQL starts and accepts connections
- [ ] All expected tables present
- [ ] Sample data queries return expected counts
- [ ] RLS smoke test passes
- [ ] Audit log integrity intact

## Findings
<any issues or surprises>

## Actions
<follow-ups>

## Next drill
<scheduled date>
```

### 8.3 Quarterly Failover Drill

**Objective:** Practice the actual failover procedure under controlled conditions.

**Procedure** (planned in advance, communicated to all customers as a maintenance window):

1. Pre-drill: notify customers of maintenance window (2-hour window, expect brief read-only mode)
2. Drill steps:
   - Promote wardenx-db-02 to primary
   - Cut traffic over
   - Verify operations on new primary for 30 min
   - Cut back to wardenx-db-01 after re-establishing as replica
3. Document timing of each step vs. RTO target
4. Identify procedural gaps or surprises
5. Update this DR document with learnings

### 8.4 Annual Full DR Exercise

**Objective:** Simulate regional disaster — primary site unavailable — restore from off-site.

**Procedure** (planned annually, executed in test environment):

1. Spin up alternate hardware (cloud VM cluster or alternate hosting)
2. Restore from off-site pgBackRest, MinIO, and PBS
3. Bring full stack up
4. Run regression test suite
5. Document total time, identify bottlenecks
6. Calculate what the actual RTO would be under realistic conditions
7. Adjust infrastructure or procedures if targets are not being met

### 8.5 Drill Calendar (2026)

| Date | Drill | Owner |
|---|---|---|
| First Sat each month | Monthly restore drill | Fabrice |
| 2026-03-15 | Q1 failover drill | Fabrice |
| 2026-06-15 | Q2 failover drill | Fabrice |
| 2026-09-15 | Q3 failover drill | Fabrice |
| 2026-12-15 | Q4 failover drill | Fabrice |
| 2026-08-01 | Annual full DR exercise | Fabrice + contracted assistance |

---

## 9. Communication Plan

### 9.1 Internal Communication During Incident

| Channel | Purpose | Used For |
|---|---|---|
| Phone (Fabrice's direct line) | Wake-up notification | SEV-1 page from PagerDuty |
| Slack / Signal | Real-time coordination | All severity levels during incident |
| Status page (status.wardenx.app) | Customer-facing public log | SEV-1 and SEV-2 |
| Email distribution list (incidents@wardenx.app) | Compliance & legal CC | SEV-1, suspected breach |
| Incident retrospective doc | Permanent record | All SEV-1 and SEV-2 post-incident |

### 9.2 Customer Communication

Status page (status.wardenx.app) is the authoritative customer-facing communication channel during incidents. Customers can subscribe to alerts via email or RSS.

**Communication templates:**

#### 9.2.1 Initial Acknowledgment (within target time per severity)

```
🟡 Investigating — <Component> degraded

We are investigating reports of <user-visible symptom>.
Affected systems: <list>
Patient care impact: <yes/no/limited>
Workaround: <if available>

Next update: <time>
```

#### 9.2.2 Status Update

```
🟡 Identified — <Component> degraded

Root cause identified as <brief>. We are now <action>.
Affected systems: <list>
Patient care impact: <description>
Workaround: <if any>
Estimated resolution: <time> (subject to change)

Next update: <time>
```

#### 9.2.3 Resolution

```
🟢 Resolved — <Component> incident resolved

The incident affecting <system> has been resolved.

Duration: <start> to <end> (X hours Y minutes)
Affected systems: <list>
Root cause: <brief>
What we did: <brief>
What we'll do to prevent recurrence: <commitments>

A detailed post-incident review will be published within 7 days at <link>.
```

#### 9.2.4 Post-Incident Review Template

```markdown
# Post-Incident Review — <Title> — YYYY-MM-DD

**Severity:** SEV-X
**Duration:** start to end (X hours Y minutes)
**Customer impact:** <description>
**RTO target / actual:** X / Y
**RPO target / actual:** X / Y

## Summary
<2-3 sentence executive summary>

## Timeline
- HH:MM Event
- HH:MM Detection
- HH:MM Response begins
- HH:MM Mitigation applied
- HH:MM Service restored
- HH:MM Verification complete
- HH:MM Customer-facing announcement

## Root Cause
<technical description>

## Resolution
<what we did>

## Customer Impact
<who was affected, how, for how long>

## What Went Well
<honest list>

## What Didn't Go Well
<honest list>

## Action Items
| # | Owner | Action | Due |
|---|---|---|---|
| 1 | Fabrice | <action> | <date> |

## Lessons Learned
<insights>
```

### 9.3 Regulatory Notification — HIPAA Breach Rule

HIPAA Privacy Rule §164.404 requires notification when there is "unauthorized acquisition, access, use, or disclosure" of PHI.

**Breach assessment process** (kicked off by IC + Compliance Officer for any SEV-1 with potential PHI exposure):

1. Determine: did PHI access/disclosure occur outside the minimum-necessary, properly-authorized scope?
2. If yes, conduct 4-factor risk assessment:
   - Nature and extent of PHI involved
   - Unauthorized person who used/received PHI
   - Whether PHI was actually acquired or viewed
   - Extent of risk mitigation
3. Document assessment in writing
4. If conclusion is "low probability of compromise" — internal documentation only
5. If conclusion is "more than low" — breach notification required

**Notification timeline:**

- **To affected individuals:** within 60 calendar days of breach discovery
- **To HHS Secretary:** within 60 days if affecting >500 individuals; in annual log if <500
- **To media:** within 60 days if breach affects >500 individuals in a state/jurisdiction
- **To affected covered entity (since WardenX is a business associate):** "without unreasonable delay" and no later than 60 days — actual reporting practice is much faster, typically within days of confirmed breach

**Documentation requirements:** All breach assessments, decisions, notifications, and supporting evidence retained 6+ years.

**Note:** WardenX is a HIPAA Business Associate to customer hospice agencies. Customers (Covered Entities) hold primary breach notification responsibility to patients; WardenX assists them with required information.

### 9.4 Vendor Escalation Contacts

Maintained as a separate doc (`docs/dr/vendor-escalation.md`) updated quarterly:

| Vendor | Service | Standard support | Escalation contact | BAA status |
|---|---|---|---|---|
| DoseSpot | E-prescribing | ticket portal | Account manager phone | Yes |
| Anthropic | AI API | console | Enterprise support | TBD (BAA negotiation) |
| Twilio | SMS/Voice | console | Enterprise support | Yes (HIPAA edition) |
| Postmark | Email | console | Account manager | Yes (HIPAA tier) |
| Stripe | Subscription billing | console | Account manager | N/A (no PHI) |
| NGS (MAC J6) | Medicare claims | MAC support | EDI hotline | Per CMS terms |
| Oregon Medicaid (OHA) | Medicaid claims | provider services | OHA EDI contact | Per state contract |
| iQIES (CMS) | HOPE submission | CMS QIES help desk | regional CMS contact | Per CMS terms |
| Xero | Accounting MCP | console | account manager | N/A (no PHI in API surface used) |
| Gusto | Payroll | console | account manager | N/A (no PHI) |
| Proxmox / hardware vendor | Infrastructure | vendor support | next-business-day contract | N/A |

---

## 10. Regional Disaster Scenarios

### 10.1 Disaster Categories

| Category | Scope | Examples |
|---|---|---|
| Local | Single VM or service | VM crash; software bug |
| Cluster | Single Proxmox host | Host hardware failure; host crash |
| Site | All Proxmox hosts at primary location | Datacenter fire/flood; extended power outage; ransomware affecting hypervisor |
| Regional | Multiple sites in geographic area | Earthquake; widespread utility failure |
| Vendor | External vendor outage | Anthropic down; AWS down (if cloud-deployed) |

### 10.2 Site Disaster Response Plan

**Trigger conditions:** All production VMs unreachable for > 1 hour with no recovery path; hardware/site catastrophe confirmed.

**Phase 1 — Stabilize (0-2 hours):**

1. Activate IC; declare SEV-1 site disaster
2. Notify customers via status page: "We are responding to a site-level incident; full recovery underway"
3. Activate BCP (§11) — customers transition to paper procedures
4. Verify off-site backups are accessible
5. Provision alternate infrastructure (initial plan: cloud VMs as DR target — see §10.3)

**Phase 2 — Restore (2-12 hours):**

1. Restore PostgreSQL from off-site pgBackRest to alternate site
2. Restore MinIO from off-site replica
3. Deploy containers from GHCR
4. Restore secrets from SOPS using off-site age keys (held in fire safe + with trusted secondary holder)
5. Bring services up in dependency order
6. Run full smoke test suite
7. Update DNS to point to alternate site (TTL planned at 60 sec for failover-critical records)

**Phase 3 — Verify & Reopen (12-24 hours):**

1. Customer notification: site recovery proceeding; staged reopen
2. Engrace (founding customer) verifies their workflow first
3. Other tenants enabled in groups
4. Resume normal monitoring

**Phase 4 — Permanent Resolution (days to weeks):**

1. Either: rebuild primary site and migrate back
2. Or: make alternate site the new primary
3. Re-establish full DR posture (backups, replication, off-site)

### 10.3 DR Target Selection (ADR-002 — currently OPEN)

The off-site DR target is flagged in Architecture v0.9 as ADR-002. Options under consideration:

**Option A: Second Proxmox cluster at separate physical site**
- Pro: Full architectural parity; no cloud lock-in; encrypted backup transit
- Con: Capex; requires physical security for second site; geographical proximity may not satisfy regional disaster scope

**Option B: Cloud (AWS / GCP / Hetzner) as cold DR**
- Pro: Geographic diversity; no capex; spinning up takes minutes
- Con: BAA required (AWS HIPAA-eligible, GCP HIPAA-eligible, Hetzner not HIPAA-friendly in US); ongoing cost for cold infrastructure; vendor lock-in if it becomes warm

**Option C: Hybrid — cold offsite encrypted backups + on-demand cloud spinup**
- Pro: Lowest ongoing cost; cloud only when needed
- Con: Cloud spinup adds to RTO; requires automation tested regularly

**Recommended for Phase 1 (Engrace launch):** Option C (Hybrid). Backups encrypted off-site (cheap, simple), with Ansible/Terraform recipes ready to spin up AWS cluster on demand. Tested quarterly via §8.4 annual DR exercise.

**Required for Phase 2 (multi-tenant):** Reassess; likely move to Option A (warm second site) as customer SLAs tighten.

### 10.4 Specific Catastrophic Scenarios

#### 10.4.1 Ransomware

**Detection signals:**
- Mass file encryption alerts (Crowdstrike-equivalent endpoint detection if deployed)
- Unusual database query patterns (large-scale DELETE or UPDATE)
- Backups failing or being deleted
- Ransom note on file shares

**Response:**

1. **Immediate isolation:** disconnect affected hosts from network (don't shut down — preserves forensic state)
2. Declare SEV-1; engage cybersecurity counsel within 1 hour
3. Determine scope: which VMs affected? Backups intact?
4. **Do NOT pay ransom** — Anthropic / company policy + likely sanctions exposure + no guarantee of decryption
5. **Restore from known-clean backup point** (before infection) — likely 24-48 hour data loss depending on detection lag
6. Forensic preservation: backup the encrypted state for investigation
7. Notify customers — likely a breach under HIPAA (assume PHI exposure unless proven otherwise)
8. Engage cyber-insurance carrier (Phase 2 requirement; not yet in place for solo dev)
9. Notify FBI (cybercrime — IC3 reporting)
10. Notify state attorney general (where applicable per state breach law)

**Specific protections in WardenX architecture against ransomware:**
- pgBackRest backups encrypted with keys not on primary infrastructure
- Off-site backups not accessible from primary network
- MinIO object lock on compliance buckets (claims, cost reports) — cannot be overwritten or deleted for 7 years
- RLS prevents one tenant's compromised account from accessing another tenant's data
- Audit log is INSERT-only via wardenx_app role — UPDATE/DELETE require wardenx_admin (separate credential)
- Separate backup VM with its own credentials

#### 10.4.2 Insider Threat / Malicious Access

**Detection signals:**
- Unusual access patterns in audit log (off-hours, bulk reads, unfamiliar IPs)
- Failed RLS denials in logs (attempted cross-tenant access)
- Unexpected role changes
- Data exports outside normal pattern

**Response:**

1. **Account suspension:** disable suspected account; invalidate sessions
2. Forensic preservation: snapshot audit logs, session records, application logs
3. Engage cybersecurity counsel; this is potentially criminal
4. Document scope of unauthorized access
5. HIPAA breach assessment per §9.3
6. Customer notification per breach rules
7. Internal review: how did the actor obtain access? What controls failed?

#### 10.4.3 Anthropic API Extended Outage

**Severity:** SEV-2 (degrades AI features; clinical care continues)

**Procedure:**

1. Activate `external.anthropic_kill` feature flag — disables all Anthropic-dependent features immediately
2. Status banner shows: "AI features temporarily unavailable. Clinical documentation and operations continue normally."
3. Affected features fall back:
   - HearthNote Layer 2 → Layer 1 only (deterministic narrative still works)
   - DocLens → manual chart entry (no extraction)
   - AI copilot → unavailable
   - Predictions → hidden in UI
4. Monitor Anthropic status; deactivate kill switch when service restored
5. Document outage duration in §3.3 actual-RTO tracking (Tier 4 service)

#### 10.4.4 DoseSpot Extended Outage

**Severity:** SEV-2 (degrades prescribing workflow; patient safety implications if not handled)

**Procedure:**

1. Activate `external.dosespot_kill`
2. Status banner: "Electronic prescribing via DoseSpot is currently unavailable. Please use paper prescription pads for new orders and document in eMAR upon administration."
3. Customer agencies fall back to:
   - Paper prescription pads (controlled substances by phone to pharmacy per state DEA emergency rules)
   - Manual entry of administered meds in eMAR
   - When DoseSpot restored, reconciliation workflow: enter paper prescriptions retroactively
4. Escalate to DoseSpot enterprise support immediately

#### 10.4.5 MAC Portal Outage (NGS J6 for Engrace)

**Severity:** SEV-3 (delays billing; not patient-care affecting)

**Procedure:**

1. Generated 837I files queue locally in Module 23
2. Status banner for billing staff: "Claim submission temporarily delayed."
3. Monitor MAC status via NGS portal status page
4. When portal recovers, queue processes automatically
5. If outage exceeds 7 days approaching NOE 5-day-window deadlines for new admissions: escalate, document, NGS typically allows late filing in regional outages with documentation

#### 10.4.6 Database Corruption from Application Bug

**Detection:** Anomalous data observed (impossible state, foreign key violations, missing required fields, audit log gaps); often reported by customers.

**Response:**

1. SEV-1: declare; activate IC
2. Identify the introducing code commit; rollback application immediately
3. Identify scope: which tables? which rows? when did corruption start?
4. Decision: forward-fix (apply corrective SQL) or rollback (PITR before corruption)
5. If small-scope and isolated: forward-fix with careful SQL + audit log of corrections
6. If large-scope or unclear: PITR (§7.1) to point before corruption; reconcile any work done in interim with customers
7. Post-incident: code review process gap; add regression test

---

## 11. Business Continuity for Clinical Operations

This section is written for **clinical staff at customer agencies** so they know what to do when WardenX is unavailable.

### 11.1 Degraded-Mode Operations

[CLINICAL] Most WardenX outages are short and self-recovering. The status banner in the application will indicate degraded mode. During degraded mode:

- **Available:** patient lookup, encounter draft (saved locally on mobile, syncs on recovery), care plan view, eMAR view, medication list, document download
- **Limited:** real-time alerts may be delayed; AI features (HearthNote enhancement, DocLens) may be disabled
- **Unavailable:** new prescription via DoseSpot (if DoseSpot is the affected service); new claim submission

Continue clinical care normally. The system will catch up when the affected component is restored.

### 11.2 Full Outage Procedures

[CLINICAL] When WardenX is completely unavailable, customer agencies fall back to paper procedures. **Patient care must continue.**

WardenX provides each customer agency with a "BCP packet" of pre-printed forms covering:

- **Encounter visit note (paper version)** — captures vital information identically to the electronic form
- **Medication administration record (paper MAR)** — for documenting administered meds during outage
- **Order form** — for new orders during outage
- **Patient information card** — quick reference to active patient information (printed weekly for active census; updated more often for higher-acuity)
- **Emergency contact sheet** — for each patient, with caregiver/family contacts
- **Symptom assessment forms** — paper versions of PPS/FAST/PAINAD/ESAS for documentation continuity

### 11.3 Re-Entry Workflow

[CLINICAL] When WardenX is restored, paper records must be entered into the system. Module 8 Encounters has a "BCP re-entry mode" that:

- Marks the encounter with a `bcp_paper_origin = true` flag
- Captures the original paper signature date and time
- Audit log shows that this record originated on paper during a system outage
- Late entry does NOT change the visit date (back-dated to actual visit date)

Re-entry should be completed within 72 hours of system restoration. The Field Operations role has a "BCP Re-Entry Worklist" view to track outstanding paper records.

### 11.4 During Outage — Communication

[CLINICAL] During WardenX outage:

- Care team coordination falls back to phone, in-person, or agency's own existing channels
- Hospice agency's existing emergency contact tree applies (WardenX provides the EHR; agency's clinical operations are not WardenX-dependent in this layer)
- WardenX provides status updates via status page; agency designates a staff member to monitor and relay to clinical team

### 11.5 Continuous Care Patients (CHC and GIP)

[CLINICAL] Patients on Continuous Home Care (CHC) or General Inpatient (GIP) require continuous nursing presence regardless of EHR state. The on-duty RN documents on paper continuously; re-entry occurs after system restoration. **CHC/GIP eligibility and billing are not affected by EHR outage** — the documentation requirement is satisfied by paper records during outage.

### 11.6 Safety-Critical Functions That Must Be Preserved

[CLINICAL] No matter what is down, these must remain available to the agency:

- Patient name, address, location, primary diagnosis (printed weekly to BCP packet)
- Active medication list (printed weekly)
- Active orders (printed weekly)
- Allergies (printed weekly)
- Code status and advance directive summary (printed weekly)
- Emergency contacts (printed weekly)
- Designated DPOA agent (printed weekly)

The Weekly BCP Print job (scheduled via BullMQ) generates these printables for every active patient. Agencies receive these via email + maintain printed copies in patient binders. **In a total outage, the printed binder is the source of truth.**

---

## 12. HIPAA Contingency Plan Compliance Mapping

This document satisfies the requirements of HIPAA Security Rule §164.308(a)(7) Contingency Plan implementation specifications:

| HIPAA Requirement | Section of this doc satisfying |
|---|---|
| §164.308(a)(7)(ii)(A) Data Backup Plan (required) | §4 Backup Architecture |
| §164.308(a)(7)(ii)(B) Disaster Recovery Plan (required) | §6 Failover Procedures, §7 Recovery Procedures, §10 Regional Disaster Scenarios |
| §164.308(a)(7)(ii)(C) Emergency Mode Operation Plan (required) | §11 Business Continuity for Clinical Operations |
| §164.308(a)(7)(ii)(D) Testing and Revision Procedures (addressable) | §8 Backup Verification & Restore Drills |
| §164.308(a)(7)(ii)(E) Applications and Data Criticality Analysis (addressable) | §3 Recovery Objectives — service tiers |

Additionally referenced HIPAA controls:

- §164.310(d)(2)(i) Disposal of media — addressed by data retention destruction certification (Architecture §24.2)
- §164.312(b) Audit controls — preserved across DR scenarios; audit log integrity has highest priority in recovery sequencing
- §164.404 Breach notification — addressed by §9.3 of this document

---

## 13. CMS Emergency Preparedness Mapping (when applicable)

If WardenX customer agencies operate an IPU (Module 37), CMS CoP §418.113 Emergency Preparedness applies to them. WardenX's role:

- We are the EHR vendor, not the IPU operator
- We do not own the IPU's emergency preparedness plan
- We assist agencies by:
  - Providing the BCP packets (§11.2) for clinical continuity during EHR outage
  - Reporting WardenX availability during the agency's own emergency exercises
  - Maintaining EHR availability to support the agency's emergency operations to the extent feasible

---

## 14. Plan Maintenance

### 14.1 Review Schedule

| Review | Frequency | Owner |
|---|---|---|
| Full document review | Annual | Fabrice |
| Post-incident review-driven updates | After every SEV-1 and SEV-2 | Fabrice |
| Architecture-change-driven updates | When Architecture or System Design changes | Fabrice |
| Vendor-change-driven updates | When a vendor in §9.4 changes | Fabrice |
| Drill-result-driven updates | After each quarterly failover drill or annual DR exercise | Fabrice |

### 14.2 Update Triggers

Specific events that trigger immediate document updates:

- New customer tenant onboarded
- New external integration added (e.g., new state Medicaid adapter, new EHR partner)
- New module added that introduces new failure modes
- Backup architecture change
- DR target site change
- Compliance regulation change affecting contingency or breach notification

### 14.3 Version Control

- Document held in `docs/dr/WARDENX_DR_BCP.md` in Git
- Material changes get version bumps (v0.1 → v0.2)
- Editorial changes do not bump version but are logged in Git history
- Each version has a sign-off date and reviewer

### 14.4 Sign-off Trail

| Version | Date | Reviewer | Notes |
|---|---|---|---|
| v0.1 | 2026-06-08 | Fabrice | Initial document; spans Phase 1 operational requirements |

---

## 15. Appendix A — Quick Reference Cards

### 15.1 SEV-1 First 15 Minutes

```
□ Acknowledge alert
□ Open incident channel (Slack #incident-NNN)
□ Verify scope: what's actually down?
□ Open status page: "Investigating <component>"
□ Activate relevant kill switches if external dependency
□ Page on-call backup if needed
□ Tell customers what you know (even if just "we are investigating")
□ Start incident timeline doc
```

### 15.2 PostgreSQL Primary Down — Decision Tree

```
PG primary unreachable for 5 min?
├── Yes → Can replica be promoted? (check lag, integrity)
│        ├── Yes → Execute §6.1 procedure
│        └── No → Go to §7.1 PITR from backup
└── No → Wait + investigate; reclassify if recovers
```

### 15.3 Ransomware Indicators — Don't Touch Anything

```
Ransom note found OR mass encryption alerts
│
└── 1. Isolate affected hosts (disconnect network — DON'T shut down)
    2. Page IC + compliance counsel
    3. Verify off-site backups intact and unaffected
    4. DO NOT pay ransom
    5. Preserve forensic state
    6. Plan restore from known-clean backup point
```

### 15.4 PHI Exposure Suspected — First Actions

```
PHI exposure suspected
│
├── Contain: lock affected accounts, revoke sessions
├── Preserve: snapshot logs, audit, sessions
├── Notify: IC + Compliance Officer + counsel within 1 hour
├── Document: what, when, who, scope
├── Assess: 4-factor risk assessment (§9.3)
└── Decide: breach notification yes/no within 24 hours
```

---

## 16. Appendix B — Glossary

| Term | Definition |
|---|---|
| **RTO** | Recovery Time Objective — how quickly service is restored after failure |
| **RPO** | Recovery Point Objective — maximum acceptable data loss measured in time |
| **PITR** | Point-In-Time Recovery — restoring database to a specific timestamp |
| **WAL** | Write-Ahead Log — PostgreSQL's transaction log used for replication and PITR |
| **BCP** | Business Continuity Plan — keeping operations running through disruption |
| **DR** | Disaster Recovery — restoring after major failure |
| **SEV-1/2/3/4** | Severity classification — see §2.3 |
| **IC** | Incident Commander — single decision-maker during incident |
| **BAA** | Business Associate Agreement — HIPAA contract with vendor handling PHI |
| **PHI** | Protected Health Information per HIPAA |
| **MAC** | Medicare Administrative Contractor — processes Medicare claims |
| **IPU** | Inpatient Unit — hospice inpatient setting under CoP 418.108/110 |
| **NOE** | Notice of Election — hospice enrollment filing required within 5 days |
| **CTI** | Certification of Terminal Illness — required for hospice election |
| **CoP** | Conditions of Participation — CMS requirements for hospice agencies |
| **HQRP** | Hospice Quality Reporting Program |
| **HOPE** | Hospice Outcomes & Patient Evaluation — current assessment tool |

---

**End of WARDENX_DR_BCP v0.1.**
