# ADR-0050 — Production moves from a single Compose VPS to Talos Linux / Kubernetes behind Pangolin, deployed by GitOps pull

- **Status:** **Proposed** — the product owner has decided:
  - D1 hosting: Hostinger test → OVHcloud production → Hostinger playground
  - D3: CloudNativePG
  - D4: Argo CD
  - D5: External Secrets + OpenBao
  - D6 object store: Garage

  It stays Proposed until the three open questions below are settled.
- **Date:** 2026-10-05
- **Phase:** production platform.
- **Supersedes (when Accepted):** System Design §2.4 ("Why Not Kubernetes Initially"), and §2.2's VM
  allocation as the *runtime* layout. Production runs on OVHcloud bare metal, not Proxmox (D1).
- **Amends (when Accepted):** Architecture §18 (the "Deploy" bullet: "Proxmox VMs pull via
  systemd-managed compose"), §19, and the §14 "Encryption at rest" row; DR/BCP §4.1 (pgBackRest → CloudNativePG) and §4.2
  (MinIO → Garage); the Ops Runbook; `.github/workflows/deploy.yml`'s `deploy` job.
- **Related:** [ADR-0049](ADR-0049-tenant-subdomains.md) (the Pangolin wildcard edge this platform sits
  behind), [ADR-0045](ADR-0045-platform-kek-custody.md) (the env-held platform KEK, which becomes a
  Kubernetes Secret here), [ADR-0010](ADR-0010-tenancy-rls-invariants.md) (the NOBYPASSRLS
  `wardenx_app` role this ADR must preserve), [Platform Tools Manual](../PLATFORM_TOOLS_MANUAL.md) (the
  operating manual for every tool named here), [ADR-0038](ADR-0038-app-layer-envelope-encryption.md)
  (application-layer encryption, unchanged).

## Context

**What runs today.** Production is one Hostinger VPS running Docker Compose
(`deploy/production/compose.yml`):

- Stateful services: `postgres` (pgvector pg18), `valkey`, `minio`, each on a local named volume.
- One-shot jobs: `migrate` and `provision`.
- Long-running app containers: `api`, `worker`, `web`.
- Edge: host nginx.

Deploys run from `deploy.yml`'s `deploy` job, on a self-hosted runner. It SSHes to the VPS and runs
`deploy/production/deploy.sh`, which:

- verifies the image's cosign keyless signature against a pinned workflow identity (F-040);
- pins the verified digest;
- validates the production env contract in the new image;
- migrates, then recreates `api` / `worker` / `web`;
- rolls back images on failure, warning loudly when migrations were applied.

**What that topology cannot do:**

- **Every component is a single point of failure.** There is no second API instance, no database
  replica and no WAL archiving. DR/BCP itself says "no streaming replica and no WAL archiving are
  running", so its Tier-1 target (1 h RTO / 5 min RPO) is aspirational.
- **Deploys are push-over-SSH.** The deploy host holds a shell key, and the self-hosted runner's
  availability gates every release.
- **There is no declarative record of the running state.** The production configuration lives in an
  untracked `.env.production`. GAP-152 in the 2026-10-04 audit: the template `bootstrap-vps.sh` reads
  was never committed.

**The decision to move.** System Design §2.4 rejected Kubernetes as "overhead unjustified for … a
handful of production VMs". That premise has changed:

- ChartWarden is multi-tenant, with per-tenant subdomains (ADR-0049).
- The DR targets require replicas and continuous archiving.
- Workloads are multiplying: the docling sidecar, local-model inference, X12 workers.

The product owner has chosen **Talos Linux + Kubernetes behind Pangolin** as the production
platform. This ADR records the shape of that platform. Talos is an immutable, API-managed Kubernetes
OS with no SSH and no shell.

## Decision

### D1 — Cluster: Talos Linux, three nodes, in three hosting phases

**Hosting** *(decided by the product owner, 2026-10-05)*:

| Phase | Where | Purpose | Data |
|---|---|---|---|
| Stage 0 (now) | Hostinger servers | Build and rehearse the whole platform; prove the app and the cutover | **Synthetic only** |
| Stage 1 | OVHcloud bare metal, Oregon region (East region later for DR) | Production | Real PHI, under OVHcloud's BAA |
| After stage 1 | The Hostinger cluster, kept | Permanent playground: upgrade rehearsals, experiments, drills | **Synthetic only**, no production credentials |

- **Production stays put until stage 1.** The current Compose VPS remains production throughout stage 0.
  Hostinger is not a production target unless Hostinger signs a BAA, so neither the Hostinger test cluster
  nor the playground may ever hold PHI or a production secret.
- **Before stage-0 work starts, confirm two things:**
  - **Hostinger:** the servers can boot a custom Talos image (Image Factory ISO or disk image).
  - **OVHcloud:** the BAA covers the bare-metal product actually rented.

- **Nodes:** three Talos nodes, each a control-plane node that also schedules workloads. etcd needs
  three members to survive losing one. Dedicated worker nodes join when load requires; the inference
  node with GPU passthrough is the first expected one.
- **Configuration:** Talos machine config is declarative. Its non-secret patches live in the repo
  under `deploy/talos/`; the Talos secrets bundle never does (D5 bootstrap). Nodes are managed only through `talosctl` with mTLS. There is no SSH, which removes
  the deploy host's shell key from the threat model.
- **Disk encryption:** Talos's LUKS2 disk encryption is enabled on the STATE and EPHEMERAL partitions.
  It replaces "LUKS on Proxmox volumes" in §14; application-layer envelope encryption (ADR-0038) is
  unchanged.
- **Networking:** Cilium is the CNI and is enforced with a **default-deny** NetworkPolicy per
  namespace. Only the flows the app needs are opened: ingress → api/web, api/worker →
  postgres/valkey/garage, worker → docling, and egress to named integration endpoints.

### D2 — Workloads map one-to-one from Compose

| Compose service | Kubernetes object | Notes |
|---|---|---|
| `api` | Deployment, **≥ 2 replicas**, PodDisruptionBudget `minAvailable: 1` | Readiness `/ready`, liveness `/health` (the probes `deploy.sh` already uses) |
| `worker` | Deployment (`PROCESS_ROLE` worker) | BullMQ is safe with several consumers; start at 1 replica, then scale |
| `web` | Deployment (static SPA) | Serves `/` and `/portal/` per ADR-0049 D7 |
| `migrate` | Job, run before each api/worker rollout (D4 ordering) | Keeps `deploy.sh`'s expand-only rollback caveat |
| `provision` | Job | Creates the NOBYPASSRLS `wardenx_app`, platform and destruction roles; idempotent |
| `postgres` | see D3 | |
| `valkey` | StatefulSet, 1 replica, persistent volume | Cache and queues only; rebuildable. Use `valkey/valkey:8` |
| `minio` | **Garage** StatefulSet (D6) | Production only; local development keeps MinIO |
| docling sidecar | Deployment (CPU) | Already a separate service per ADR-0048 |
| local inference (Ollama) | Deployment on the GPU node when present | Optional, as today |

- **Ingress:** **Envoy Gateway** (Gateway API), with no public LoadBalancer IP. It receives Pangolin's
  traffic and path-routes `/api/`, `/portal/` and `/` (ADR-0049 D2). **Not ingress-nginx**, which the
  Kubernetes project has retired.
- **Pangolin connection:** Pangolin reaches the cluster through its tunnel client, **Newt**, running
  in-cluster as a Deployment, so no inbound port is opened on the nodes.
- **Proxy trust:** `TRUSTED_PROXY_CIDRS` is set to the ingress pods' CIDR, so `X-Forwarded-*` is
  honoured only from the ingress.

### D3 — PostgreSQL: CloudNativePG in-cluster *(decided by the product owner, 2026-10-05)*

- **Topology:** the CloudNativePG operator runs a `Cluster` with one primary and two streaming
  replicas (one per node) using the pgvector image, with automated failover. Replication is
  **synchronous with at least one synchronous standby**, so losing the primary loses no committed
  transaction (RPO ≈ 0 for node failure).
- **Backups:** continuous WAL archiving and scheduled base backups go **directly** through barman-cloud
  to an off-site, encrypted, BAA-covered S3-compatible target with **Object Lock**. They are written with
  credentials that cannot delete, so neither a cluster loss nor an attacker holding cluster credentials
  can destroy the recovery path. A nightly copy into the in-cluster Garage speeds up routine restores;
  it is never the only copy. Point-in-time recovery makes DR Tier-1's 5-minute RPO real.
- **What it replaces:** DR/BCP §4.1's pgBackRest design. The VM-based alternative (dedicated Postgres
  VMs with pgBackRest) was considered and rejected: hand-built failover, and a second operational
  surface with no declarative state.
- **Invariants preserved:**
  - The app connects as NOBYPASSRLS `wardenx_app`, and boot still refuses a BYPASSRLS runtime role.
  - Superuser credentials never reach app pods.
  - `provision` creates the app, platform and destruction roles exactly as today.
  - Migrations run through the `migrate` Job's own credential.
- **Pooling:** connections go through CloudNativePG's `Pooler` (PgBouncer) in transaction mode, *only
  after* the live suites prove the `app.org_id` GUC handling is transaction-scoped under it. Until
  then the app connects to the `-rw` Service directly.
- **Restore drill:** a restore is rehearsed quarterly into a scratch `Cluster` from the off-site
  backups, and the RTO actually achieved is recorded per DR/BCP §3.3.

### D4 — Deploys are GitOps pull: Argo CD *(decided by the product owner, 2026-10-05)*

- **CI builds; the cluster pulls.** CI keeps building and signing images (`release` job unchanged).
  The `deploy` job no longer SSHes. It commits the new image **digest** to the environment overlay
  (`deploy/k8s/overlays/production/`), and Argo CD in the cluster syncs it. No inbound credential to
  production exists anywhere in CI.
- **Structure:** app-of-apps. One root `Application` per environment owns child `Application`s:
  - platform: Cilium config, the CloudNativePG operator, External Secrets, OpenBao, Garage, the policy
    controller, observability
  - ChartWarden itself

  Sync waves order them: CRDs and operators, then data services, then the app.
- **Migration ordering:** `migrate` and `provision` are Argo CD **`PreSync` hook** Jobs
  (`hook-delete-policy: BeforeHookCreation`). If either fails, the sync fails, the new ReplicaSets are
  never created, and the current pods keep serving. That replaces `deploy.sh`'s manual image
  rollback. The expand-only migration discipline still applies: the old code must run against the
  new schema.
- **Sync policy:** automated sync with `selfHeal` (a manual `kubectl` edit is reverted to Git). `prune`
  is on for app resources, and **off** for data services (CloudNativePG `Cluster`, Garage, OpenBao), so
  a bad commit can never delete a database.
- **Signature verification moves into admission, at stage 1.** Kyverno (`verifyImages` plus
  digest pinning, in Enforce mode from the first production sync) refuses any pod whose image lacks a
  keyless signature from **this repository's `deploy.yml` on `main`**. That is the same identity
  `deploy.sh` pins today, so the F-040 property is enforced for *every* pod, not just at deploy time.
  Once `deploy.sh` is gone, admission is the only place this check runs, so it cannot wait for stage 2.
  Kyverno's other policies (non-root, read-only root filesystem, and so on) roll in through Audit mode
  at stage 2.
- **Argo CD hardening:** Argo CD holds cluster-admin, so it is the most sensitive service in the
  cluster.
  - The local `admin` account is disabled after bootstrap. Sign-in is SSO only, with RBAC: owners can
    sync, everyone else is read-only.
  - The UI and API are internal only, reached through Pangolin with Pangolin's own authentication,
    never a public tenant host.
  - The repository credential is a read-only deploy key.
- **CI minutes:** the `debounce` gate (#257) stays in front of `release`. The `deploy` job shrinks to
  one small commit, so Actions minutes drop.
- **Alternative considered:** Flux CD (CLI- and Git-native, lighter). Argo CD was chosen for its
  application view and sync and rollback UI.

### D5 — Secrets: External Secrets Operator + OpenBao *(decided by the product owner, 2026-10-05)*

- **Source of truth:** OpenBao (the open-source Vault fork) runs in-cluster as a three-replica
  integrated-storage (Raft) StatefulSet. It holds every production secret: the ADR-0045 platform KEK,
  `BETTER_AUTH_SECRET`, `TWO_FACTOR_ENCRYPTION_KEY`, the DB role passwords, Garage keys and
  integration credentials. Paths are per environment, for example
  `kv/wardenx/production/<component>`.
- **Delivery:** External Secrets Operator syncs them into Kubernetes Secrets.
  - A `ClusterSecretStore` uses ESO's Vault provider, which is API-compatible with OpenBao, and
    authenticates with OpenBao's Kubernetes auth method.
  - Each workload has an `ExternalSecret` with a refresh interval.
  - Pods read the Secrets as env vars, as today, so app code does not change, and ADR-0045's
    env-held-KEK model holds.
  - A rotated secret rolls the pods that use it (via a reloader).
- **Audit:** OpenBao's audit device is enabled, so every secret read and write is logged and shipped
  to Loki. That gives the secret-access trail HIPAA §164.312(b) expects, which a Git-held secret could
  not.
- **What this fixes:** GAP-152's root cause. The full production key set is enumerated as
  `ExternalSecret` manifests in Git (names, never values) and held in one audited store, instead of an
  untracked `.env.production`.
- **Least privilege:** each workload's Kubernetes service account maps to an OpenBao policy that can
  read only its own paths. App pods can never read the destruction credential, which only the
  destruction worker's account can read, or the Talos and OpenBao root material.
- **Bootstrap (the chicken-and-egg).** OpenBao lives inside the cluster it serves, so three things
  live *outside* it:
  1. **Talos secrets bundle:** generated once, never committed, kept in the owner's offline encrypted
     backup. The repo holds only non-secret Talos config patches under `deploy/talos/`.
  2. **OpenBao unseal:** auto-unseal from a key held outside the cluster, so a pod restart never
     needs a human. Shamir manual unseal is rejected because a 3 a.m. node reboot would take every
     secret, and so the app, offline until an operator arrives. The exact seal mechanism is an open
     question.
  3. **OpenBao recovery keys and root token:** the root token is revoked after setup. Recovery keys
     are split between the owner's offline backup and one other trusted holder.
- **Alternative considered:** SOPS + age (secrets encrypted in Git). It is simpler, but it has no
  per-read audit trail and no path to dynamic credentials.
- **Later, not in this ADR:** OpenBao's database secrets engine (dynamic, short-lived DB credentials)
  and its Transit engine as ADR-0045's `kekUnwrap` binding. Both are possible next steps, each its
  own ADR.

### D6 — Storage *(object store decided; volume provisioner recommended, needs decision)*

- **Databases:** CloudNativePG and Valkey use node-local persistent volumes (OpenEBS LocalPV or Talos
  local-path). The database replicates at the application layer, so network block storage under it
  would only add latency.
- **Object storage: Garage in production, MinIO in local development** *(decided by the product owner,
  2026-10-05)*.
  - **Production:** Garage (Deuxfleurs) runs as a StatefulSet across the three nodes with
    `replication_factor = 3` on local volumes. It replaces MinIO, whose community distribution has
    changed.
  - **Local development:** the Docker Compose stack keeps MinIO. No developer workflow changes.
  - **Why the app does not care which one runs:** the backend talks to object storage only through
    M22's zero-dependency SigV4 adapter (`apps/backend/src/modules/22-documents/seams/s3-object-store.ts`).
    It uses only:
    - path-style `GET` / `PUT` / `HEAD` / `DELETE`
    - SigV4 query-string presigned URLs
    - `x-amz-checksum-sha256` on `PUT`, read back with `x-amz-checksum-mode: ENABLED`

    It uses no bucket versioning, object lock, bucket policies, lifecycle rules or vendor admin API.
    App-level document "versions" are separate keys.
  - **Garage requirements that follow from that:**
    1. **Pin a Garage release that stores and returns `x-amz-checksum-sha256`** with checksum mode
       enabled. Pin the image by digest. The checksum read-back is the adapter's integrity check, so
       an unsupported release would fail every download.
    2. **Region:** Garage's SigV4 region (`s3_region`) defaults to `garage`. Set `MINIO_REGION` to the
       same value, or set `s3_region = "us-east-1"`. A mismatch fails every signature.
    3. **Buckets and keys** are created with Garage's admin API or CLI, not S3 `CreateBucket`. A
       bootstrap Job does it, alongside `provision`. Access keys get per-bucket read/write grants;
       Garage has no bucket policies.
    4. **Keep the env names.** `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` /
       `MINIO_REGION` keep their names: they are the adapter's S3 contract, not a MinIO dependency. A
       rename to `S3_*` is optional follow-up churn, not part of this ADR.
  - **Proof before cutover:** a live suite runs the real adapter against Garage: put with checksum,
    get and head with checksum mode, presigned GET and PUT, delete, and the M22 erase path. It runs in
    CI on a Garage container, as a `package.json` script plus a `ci.yml` job (the standing live-suite
    rule).
  - **Off-site copy** for DR/BCP §4.2: Garage has no MinIO-style bucket replication. Off-site
    protection is either a second Garage zone at another site (Garage places replicas across zones),
    or a scheduled `rclone sync` to an encrypted off-site S3 target. The choice is made in the
    DR/BCP §4.2 rewrite.
- **No Longhorn / Rook-Ceph initially.** Neither is needed while every stateful service replicates
  itself.

### D7 — Observability

- kube-prometheus-stack, Loki and Grafana in-cluster. That realises System Design's `wardenx-obs-01`
  role as workloads instead of a VM.
- Logs keep the PHI-safe Pino redaction. Nothing PHI-bearing is added at the platform layer.
- Ingress access logs must not record query strings: the GAP-073 lesson, where patient-search terms
  appeared in nginx access logs.

## Migration plan

1. **Stage 0: build on Hostinger.** Talos, Cilium, Envoy Gateway, Argo CD, OpenBao + External Secrets,
   Kyverno, storage, CloudNativePG, Valkey, Garage (with its bucket/key bootstrap Job), Newt.
   Everything is defined in Git so it can be replayed on OVHcloud.
2. **Prove the app on Hostinger (synthetic data).** Run the live suites (real `wardenx_app`,
   NOBYPASSRLS), the Garage adapter suite and the smoke test (`deploy/production/smoke.sh`). Drill
   failover, restore from the off-site backups, and OpenBao unseal and recovery.
3. **Stage 1: replay the platform on OVHcloud** from the same Git definitions. Only the environment
   overlay differs.
4. **Rehearse the cutover on OVHcloud.** `pg_dump` → restore into CloudNativePG, timed. Copy every bucket from the
   VPS MinIO into Garage with `rclone sync --checksum`, keeping keys and bucket names identical.
   Verify object counts and SHA-256s, and row counts.
5. **Cut over.** In a maintenance window: freeze writes on the VPS, take the final dump and restore,
   then point the Pangolin resource at the cluster. The VPS stays warm and read-only for 14 days as
   the rollback path.
6. **Decommission** the Compose VPS, the SSH deploy secrets and the deploy job's self-hosted runner.
   The Hostinger cluster becomes the playground. Its Argo CD tracks a separate `playground` overlay,
   and it never receives production secrets.

## Consequences

- System Design §2.4 is superseded, and §2.2's Proxmox VM table is replaced by the three-phase hosting in
  D1.
- `deploy/production/` (Compose + `deploy.sh`) is retired after cutover, and `deploy/k8s/` becomes the
  source of truth. `deploy.sh`'s safeguards survive in new places:
  - the production env-contract check → an init container
  - the cosign identity pin → admission policy
  - the migration-aware rollback → Job gating plus the expand-only discipline
- DR/BCP §3 targets become achievable (replica + PITR). §4.1 is rewritten for CloudNativePG.
- The Ops Runbook gains Talos, Argo CD, OpenBao and CloudNativePG procedures: node replacement, failover drill, OpenBao unseal/recovery,
  restore drill, certificate and secret rotation.
- New fitness work (follow-up issues, not this ADR):
  - Kubernetes manifests must pass the policy checks (image digest pinned, signature policy present,
    no BYPASSRLS credentials in app Secrets).
  - The live suites gain a job against the Hostinger cluster (stage 0, then the playground).

## Open questions (for decision)

1. **OpenBao auto-unseal mechanism (D5):** which key outside the cluster unseals it? Candidates: a
   cloud KMS, an HSM / PKCS#11 device, or a second small OpenBao (transit seal) on separate hardware.
   Confirm what the pinned OpenBao release supports.
2. **Off-site backup target (D3):** which encrypted, Object-Lock-capable S3 provider holds the
   CloudNativePG WAL archive and base backups? It must be covered by a BAA if it is a third party.
3. **Garage off-site protection (D6):** a second Garage zone at another site, or a scheduled `rclone`
   copy to an encrypted off-site S3 target?
