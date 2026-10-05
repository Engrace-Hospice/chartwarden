# ADR-0050 — Production moves from a single Compose VPS to Talos Linux / Kubernetes behind Pangolin, deployed by GitOps pull

- **Status:** **Proposed** — draft for product-owner decision on D3 (database), D4 (GitOps tool),
  D5 (secrets), D6 (storage) and the open questions. Each has a recommended option.
- **Date:** 2026-10-05
- **Phase:** production platform.
- **Supersedes (when Accepted):** System Design §2.4 ("Why Not Kubernetes Initially"), and §2.2's VM
  allocation as the *runtime* layout. Proxmox remains the hypervisor.
- **Amends (when Accepted):** Architecture §18 (the "Deploy" bullet: "Proxmox VMs pull via
  systemd-managed compose"), §19, and the §14 "Encryption at rest" row; DR/BCP §4.1 (if D3 =
  CloudNativePG); the Ops Runbook; `.github/workflows/deploy.yml`'s `deploy` job.
- **Related:** [ADR-0049](ADR-0049-tenant-subdomains.md) (the Pangolin wildcard edge this platform sits
  behind), [ADR-0045](ADR-0045-platform-kek-custody.md) (the env-held platform KEK, which becomes a
  Kubernetes Secret here), [ADR-0010](ADR-0010-tenancy-rls-invariants.md) (the NOBYPASSRLS
  `wardenx_app` role this ADR must preserve), [ADR-0038](ADR-0038-app-layer-envelope-encryption.md)
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

- WardenX is multi-tenant, with per-tenant subdomains (ADR-0049).
- The DR targets require replicas and continuous archiving.
- Workloads are multiplying: the docling sidecar, local-model inference, X12 workers.

The product owner has chosen **Talos Linux + Kubernetes behind Pangolin** as the production
platform. This ADR records the shape of that platform. Talos is an immutable, API-managed Kubernetes
OS with no SSH and no shell.

## Decision

### D1 — Cluster: Talos Linux on Proxmox VMs, three nodes to start

- **Nodes:** three Talos nodes, each a control-plane node that also schedules workloads. etcd needs
  three members to survive losing one. Dedicated worker nodes join when load requires; the inference
  node with GPU passthrough is the first expected one.
- **Configuration:** Talos machine config is declarative and lives (encrypted, D5) in the repo under
  `deploy/talos/`. Nodes are managed only through `talosctl` with mTLS. There is no SSH, which removes
  the deploy host's shell key from the threat model.
- **Disk encryption:** Talos's LUKS2 disk encryption is enabled on the STATE and EPHEMERAL partitions.
  It replaces "LUKS on Proxmox volumes" in §14; application-layer envelope encryption (ADR-0038) is
  unchanged.
- **Networking:** Cilium is the CNI and is enforced with a **default-deny** NetworkPolicy per
  namespace. Only the flows the app needs are opened: ingress → api/web, api/worker →
  postgres/valkey/minio, worker → docling, and egress to named integration endpoints.

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
| `minio` | see D6 | |
| docling sidecar | Deployment (CPU) | Already a separate service per ADR-0048 |
| local inference (Ollama) | Deployment on the GPU node when present | Optional, as today |

- **Ingress:** a Gateway API implementation (Cilium Gateway or Traefik). It receives Pangolin's
  traffic and path-routes `/api/`, `/portal/` and `/` (ADR-0049 D2). **Not ingress-nginx**, which the
  Kubernetes project has retired.
- **Pangolin connection:** Pangolin reaches the cluster through its tunnel client, **Newt**, running
  in-cluster as a Deployment, so no inbound port is opened on the nodes.
- **Proxy trust:** `TRUSTED_PROXY_CIDRS` is set to the ingress pods' CIDR, so `X-Forwarded-*` is
  honoured only from the ingress.

### D3 — PostgreSQL: CloudNativePG in-cluster *(recommended; needs decision)*

| Option | For | Against |
|---|---|---|
| **A. CloudNativePG operator** *(recommended)* | Primary plus streaming replica with automated failover. Continuous WAL archiving and point-in-time recovery to off-site S3-compatible storage (barman-cloud), which finally makes the DR Tier-1 RPO real. The pgvector image is supported. Declarative, GitOps-managed. | Replaces DR/BCP's pgBackRest design. Database operations move into the cluster, so they need runbook coverage. |
| B. Postgres on dedicated Talos-external VMs (pgBackRest, as DR/BCP describes) | Matches the existing DR doc; the database is isolated from cluster incidents. | Hand-built replication and failover; a second operational surface; no declarative state. |

Either way:

- The live-RLS invariants are preserved. The app connects as NOBYPASSRLS `wardenx_app`, and boot still
  refuses a BYPASSRLS runtime role.
- Superuser credentials never reach app pods.
- Migrations keep running through the `migrate` Job's own credential.

### D4 — Deploys are GitOps pull: Flux CD *(recommended; needs decision)*

- **CI builds; the cluster pulls.** CI keeps building and signing images (`release` job unchanged).
  The `deploy` job no longer SSHes. It commits the new image **digest** to the environment overlay
  (`deploy/k8s/overlays/production/`), and Flux in the cluster reconciles it. No inbound credential
  to production exists anywhere in CI.
- **Signature verification moves into admission.** A policy controller (Kyverno, or Sigstore
  `policy-controller`) refuses any pod whose image lacks a keyless signature from **this repository's
  `deploy.yml` on `main`**. That is the same identity `deploy.sh` pins today, so the F-040 property is
  enforced for *every* pod, not just at deploy time.
- **Ordering:** Flux `Kustomization` dependencies run `migrate` → `provision`, then roll out `api` /
  `worker` / `web`. A failed Job halts the rollout. The previous ReplicaSet keeps serving, which
  replaces `deploy.sh`'s manual rollback.
- **CI minutes:** the `debounce` gate (#257) stays in front of `release`. The `deploy` job shrinks to
  one small commit, so Actions minutes drop.
- **Alternative:** Argo CD (UI-centric, heavier) was considered. Flux is preferred for a small team,
  because it is CLI- and Git-native and fits SOPS (D5).

### D5 — Secrets: SOPS + age in Git *(recommended; needs decision)*

- **How:** every Secret, including the ADR-0045 platform KEK, `BETTER_AUTH_SECRET`, the DB role
  passwords and integration credentials, is committed **encrypted** with SOPS (age recipients). Flux
  decrypts it in-cluster. The decryption key exists only in the cluster and in the owner's offline
  backup.
- **What this fixes:** GAP-152's root cause. The full production key set becomes a reviewed,
  versioned (encrypted) artefact instead of an untracked `.env.production`. Rotation is a commit.
- **Alternative:** External Secrets + OpenBao/Vault. Dynamic DB credentials and audit trails, at the
  cost of operating a secrets service. Revisit when the team grows.

### D6 — Storage *(recommended; needs decision)*

- **Databases:** CloudNativePG and Valkey use node-local persistent volumes (OpenEBS LocalPV or Talos
  local-path). The database replicates at the application layer, so network block storage under it
  would only add latency.
- **Object storage:** MinIO runs as its own distributed deployment across the three nodes, with
  erasure coding, on local volumes.
  - **Pin it.** The image is pinned by digest, not `latest` as today. MinIO's community distribution
    has changed; confirm a supported image or move to a compatible store before cutover.
  - **Replicate off-site** for DR/BCP §4.2.
- **No Longhorn / Rook-Ceph initially.** Neither is needed while every stateful service replicates
  itself.

### D7 — Observability

- kube-prometheus-stack, Loki and Grafana in-cluster. That realises System Design's `wardenx-obs-01`
  role as workloads instead of a VM.
- Logs keep the PHI-safe Pino redaction. Nothing PHI-bearing is added at the platform layer.
- Ingress access logs must not record query strings: the GAP-073 lesson, where patient-search terms
  appeared in nginx access logs.

## Migration plan

1. **Stand up the cluster.** Talos, Cilium, Flux, the policy controller, storage, CloudNativePG, Valkey,
   MinIO, Newt.
2. **Prove the app in staging.** Deploy it against an empty database and run the live suites (real
   `wardenx_app`, NOBYPASSRLS) and the smoke test (`deploy/production/smoke.sh`) against it.
3. **Rehearse the cutover.** `pg_dump` → restore into CloudNativePG, timed; mirror MinIO; verify
   checksums and row counts.
4. **Cut over.** In a maintenance window: freeze writes on the VPS, take the final dump and restore,
   then point the Pangolin resource at the cluster. The VPS stays warm and read-only for 14 days as
   the rollback path.
5. **Decommission** the VPS, the SSH deploy secrets and the self-hosted runner.

## Consequences

- System Design §2.4 is superseded, and §2.2's VM table becomes the Proxmox *host* layout under Talos.
- `deploy/production/` (Compose + `deploy.sh`) is retired after cutover, and `deploy/k8s/` becomes the
  source of truth. `deploy.sh`'s safeguards survive in new places:
  - the production env-contract check → an init container
  - the cosign identity pin → admission policy
  - the migration-aware rollback → Job gating plus the expand-only discipline
- DR/BCP §3 targets become achievable (replica + PITR). §4.1 is rewritten for CloudNativePG if D3 = A.
- The Ops Runbook gains Talos, Flux and CloudNativePG procedures: node replacement, failover drill,
  restore drill, certificate and secret rotation.
- New fitness work (follow-up issues, not this ADR):
  - Kubernetes manifests must pass the policy checks (image digest pinned, signature policy present,
    no BYPASSRLS credentials in app Secrets).
  - The live suites gain a job against the staging cluster.

## Open questions (for decision)

1. **Where the cluster is hosted.** The architecture assumes Proxmox in the homelab, while production
   today is a Hostinger VPS. Talos can run on either. Homelab hardware must meet DR/BCP's off-site
   requirement separately.
2. **D3:** CloudNativePG (recommended), or external Postgres VMs?
3. **D4:** Flux (recommended), or Argo CD?
4. **D5:** SOPS + age (recommended), or External Secrets + OpenBao?
5. **Staging:** a separate small cluster, or a `staging` namespace in production? A separate cluster is
   recommended for a PHI system.
6. **MinIO licensing and image:** confirm the supported distribution before cutover (D6).
