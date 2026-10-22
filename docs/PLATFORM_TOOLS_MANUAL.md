# ChartWarden Private Cloud — Platform Tools Manual

Oct 2, 2026 · @FabDev · imported into the repo 2026-10-05

> **Authority.** This is the operating manual for the platform decided in
> [ADR-0050](./adr/ADR-0050-talos-kubernetes-platform.md) (Talos / Kubernetes) and
> [ADR-0049](./adr/ADR-0049-tenant-subdomains.md) (tenant subdomains). Where the manual and an ADR
> disagree, the ADR wins. The import (2026-10-05) reconciled it with the code and both ADRs:
>
> - hosting is staged (Hostinger test → OVHcloud production → Hostinger playground);
> - tenant hosts follow ADR-0049;
> - the cosign signature policy is stage 1;
> - Valkey holds durable BullMQ queues (`noeviction`);
> - local development keeps MinIO;
> - document blobs are **not** yet encrypted before upload (an open gap, chapter 8);
> - leftover NATS references are removed.

**Updated 2026-10-02 to match the ChartWarden codebase and the ChartWarden Infrastructure Build Plan (external).** Main changes: Pangolin is now the public edge, with Envoy Gateway as internal ingress behind it. OpenBao moves to stage 1 because production keys must leave `.env.production`. Valkey is required, since the code runs its job queues on BullMQ. NATS is deferred, since the code uses a transactional outbox (ADR-0036). Garage holds one bucket per tenant. Chapters with changes carry an "Update" note under their stage line.

## 1. About this manual

This manual is the operating reference for every open-source tool in the ChartWarden private cloud: what each one does, how ChartWarden uses it, how to run it day to day, and what to do when it fails. It is written for the person operating the platform today, a solo founder-engineer, and for any engineer who joins later.

Each tool chapter follows the same structure:

| Part | What it answers |
| --- | --- |
| Role in ChartWarden | Why the tool is here and what it replaces |
| Stage | When it is adopted (see below) |
| Key concepts | The vocabulary you need to operate it |
| Deployment baseline | How it is installed and the settings that matter |
| Day-2 operations | Upgrades, backups, monitoring, routine tasks |
| Security and HIPAA notes | How it protects PHI, and what it must never do |
| Failure modes | What breaks, how you notice, first response |
| Do not | Common mistakes to avoid |

Stage tags tie each tool to the staged build plan:

- **Stage 0 (now) — Hostinger test cluster.** A three-node Talos / Kubernetes cluster on Hostinger servers, used to
  build and rehearse the whole platform (Argo CD, OpenBao, CloudNativePG, Garage, Envoy Gateway behind Pangolin).
  **Synthetic data only, never PHI**, unless Hostinger signs a BAA. The existing Docker Compose VPS stays
  production until the stage-1 cutover.
- **Stage 1 — OVHcloud production.** One region (Oregon), three bare-metal nodes on OVHcloud under a signed BAA:
  the minimum safe platform for real PHI. The Compose VPS is cut over to it and then retired.
- **After stage 1 — Hostinger playground.** The stage-0 cluster becomes a permanent playground for upgrades,
  experiments and drills. It stays synthetic-data-only and never receives production credentials.
- **Stage 2 (first paying agencies):** a warm DR region, signed artifacts, admission policy, centralized secrets.
- **Stage 3 (scale or enterprise):** SIEM, runtime detection, dedicated-tenant deployments.
- **Dev/CI only:** never part of the production data path.

Tool descriptions reflect general knowledge as of mid-2026. Exact versions, flags, and CRD fields change between releases, so pin versions and confirm settings against each project's upstream documentation before applying them.

## 2. Platform overview

The platform is split into three trust domains so that no single compromise reaches everything. The software factory builds and signs artifacts; production runs only signed artifacts; security and recovery hold the keys, the audit archive, and immutable backups that production cannot delete.

| Trust domain | Holds | May send |
| --- | --- | --- |
| Software factory | Source, CI runners, scanners, signing | Signed images and reviewed Git commits → production |
| Production | The cluster and its data | Telemetry and backups → security and recovery |
| Security and recovery | Keys, audit archive, immutable backups | Nothing back into production's control plane |

CI can only hand production a signed image and a reviewed commit; production can only send telemetry and backups down, never reach back to change or delete them.

Three rules govern the whole platform:

1. PostgreSQL is the source of truth. The transactional outbox in PostgreSQL carries events, Valkey runs the BullMQ job queues and caches, Garage stores files. Nothing else is authoritative for clinical data.
2. Production changes come only from Git, through Argo CD, after policy checks and human approval. No one runs `kubectl apply` against production, and no AI agent has production credentials.
3. A backup that has not been restored is not a backup. Restore drills are scheduled work, not optional.

### Tool adoption by stage

| Tool | Layer | Stage | Trust domain |
| --- | --- | --- | --- |
| Pangolin (self-hosted) | Public edge, tunnels, admin access | 1 | Production edge |
| Talos Linux | Node OS | 1 | Production |
| Kubernetes | Orchestration | 1 | Production |
| Cilium | Networking and policy | 1 | Production |
| Envoy Gateway, cert-manager | Internal ingress behind Pangolin | 1 | Production |
| PostgreSQL, CloudNativePG, PgBouncer | Database | 1 | Production |
| Garage | Object storage, one bucket per tenant | 1 | Production |
| Valkey | Job queues (BullMQ) and cache | 1 (required) | Production |
| OpenBao | Secrets and platform KEKs | 1 | Security and recovery |
| Argo CD | GitOps delivery | 1 | Production |
| OpenTofu, Ansible | Infrastructure as code | 1 | Software factory |
| Forgejo, CI runners | Source and CI | Open decision (GitHub Actions today) | Software factory |
| Trivy, Gitleaks, Semgrep, Renovate | Supply-chain checks | 1 | Software factory |
| Beszel, Uptime Kuma | Interim monitoring, outside OVH | 1 | Monitoring VPS |
| Prometheus, Alertmanager, Grafana, Loki, OpenTelemetry | Observability | 1 | Production |
| Velero | Cluster backup | 1 | Security and recovery |
| authentik | Admin SSO | 2 | Security and recovery |
| Harbor, Cosign, Syft, Grype | Registry and signing | 2 (GHCR and Cosign today) | Software factory |
| Kyverno | Admission policy | 1 (signature + digest policies) / 2 (the rest) | Production |
| Tempo | Tracing | 2 | Production |
| Falco | Runtime detection | 3 | Security and recovery |
| Wazuh | SIEM | 3 | Security and recovery |
| Probo or Comp AI | Compliance management (HIPAA program, later SOC 2) | 1 (policies and risk analysis now) | Software factory host (no PHI) |
| NATS JetStream | Messaging | Deferred (not used by the code) | Production |
| Floci | AWS emulation | Dev/CI only | Software factory |

OpenBao is now stage 1. The codebase holds its platform key-encryption keys (`M34_TENANT_KEK`, `M35_PSEUDONYM_KEY_KEK`) and service tokens in `.env.production` today, and those must come from OpenBao before any PHI lands on the cluster.

## 3. Talos Linux

**Stage 1 · Production · Node operating system**

### Role in ChartWarden

Talos is the operating system on every node. It exists only to run Kubernetes: it is immutable, has no shell, no SSH, and no package manager, and is managed entirely through an authenticated API. This removes configuration drift and most of the host attack surface, which matters more than usual on hosts that store PHI.

### Key concepts

- **Machine config:** one YAML document per node that declares everything about it: disks, network, cluster membership, kubelet settings. The config is the node.
- **talosctl:** the CLI that talks to the Talos API over mutual TLS. It replaces SSH for every administrative task.
- **Control plane vs worker:** control-plane nodes run etcd and the Kubernetes API; workers run workloads. ChartWarden runs three control-plane nodes for etcd quorum.
- **Image Factory and system extensions:** custom Talos images that add drivers or tools (for example, storage or GPU drivers) without breaking immutability.
- **A/B upgrades:** Talos writes the new version beside the old one and can roll back if a node fails to boot.

### Deployment baseline

- Three control-plane nodes, separate from database nodes, spread across distinct physical hosts.
- Generate secrets once with `talosctl gen secrets`; store the secrets bundle and `talosconfig` encrypted, outside the cluster, in the security domain.
- Enable disk encryption for the system and ephemeral partitions, keyed to the node or to a network key server.
- Keep machine configs in the infrastructure repository as patches over a generated base, never as hand-edited full files.
- Restrict the Talos API (port 50000) and Kubernetes API to the management network reached over WireGuard.

### Day-2 operations

- **Upgrades:** one node at a time with `talosctl upgrade`, control plane first, waiting for etcd health between nodes. Upgrade Talos before Kubernetes when both are due.
- **etcd backups:** take scheduled etcd snapshots with `talosctl etcd snapshot` and ship them to off-cluster storage. Without them, losing control-plane quorum means rebuilding the cluster.
- **Health:** `talosctl health` and `talosctl dashboard` for a quick read; node metrics flow to Prometheus.
- **Config changes:** apply with `talosctl apply-config` after review in Git; most changes apply without reboot.

### Security and HIPAA notes

- No interactive login means no one can browse PHI on a node's disk. Access is auditable API calls only.
- Protect `talosconfig` like a root password: anyone holding it controls the node.
- Disk encryption covers data at rest on node-local volumes, including PostgreSQL data directories.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Node not Ready after upgrade | Boot or kubelet failure | Check `talosctl dmesg` and services; roll back with `talosctl rollback` |
| API server unreachable | Lost etcd quorum (2 of 3 down) | Restore nodes; if impossible, recover from etcd snapshot |
| Config apply rejected | Invalid machine config | Validate with `talosctl validate` before applying |

### Do not

- Lose the secrets bundle or `talosconfig`. Back them up encrypted in two places.
- Run two of three control-plane nodes on the same physical host.
- Try to install packages or debug tools on nodes; use a privileged debug pod in a controlled namespace instead.

## 4. Kubernetes

**Stage 1 · Production · Orchestration**

### Role in ChartWarden

Kubernetes schedules and heals every ChartWarden workload: the API, web frontend, background workers, and the platform services in this manual. It replaces Dokploy and Docker Compose for production and gives the platform one declarative model that Argo CD can reconcile from Git.

### Key concepts

- **Namespace:** a boundary for policy, quotas, and RBAC. ChartWarden uses one namespace per platform concern, not per customer.
- **Deployment vs StatefulSet vs operator:** stateless services use Deployments; stateful systems (PostgreSQL via CloudNativePG, OpenBao) are run by their operators, which encode failover and backup logic.
- **RBAC:** who can do what. Humans get read access in production by default; write access flows through Argo CD's service account.
- **Pod Security Admission:** built-in enforcement of the `restricted` profile (non-root, no privilege escalation, seccomp).
- **Topology spread and anti-affinity:** rules that keep replicas on separate nodes so one host failure cannot take out all copies.
- **PodDisruptionBudget:** limits how many replicas can be down during voluntary disruption such as node upgrades.

### Deployment baseline

Namespaces:

| Namespace | Contents |
| --- | --- |
| `chartwarden-prod` | API, web, BFF services |
| `chartwarden-workers` | Background jobs, HOPE/claims processors |
| `chartwarden-integration` | Clearinghouse, eFax, external connectors |
| `database` | CloudNativePG clusters, PgBouncer |
| `storage` | Garage |
| `messaging` | Reserved for NATS (deferred, ADR-0036); not created |
| `cache` | Valkey |
| `identity` | authentik |
| `security` | OpenBao, Kyverno, Falco |
| `observability` | Prometheus, Grafana, Loki, Tempo |
| `gitops` | Argo CD |
| `ingress` | Envoy Gateway, cert-manager |

- Enforce Pod Security `restricted` on every application namespace; allow `privileged` only where a platform component genuinely needs it (Cilium, Falco).
- Every workload declares CPU and memory requests and memory limits, liveness and readiness probes, and a PodDisruptionBudget if it has more than one replica.
- Enable Kubernetes API audit logging and ship it to Loki (and later Wazuh).
- Encrypt Secrets at rest in etcd.
- Tenancy stays in the application and database (tenant IDs plus PostgreSQL row-level security). Do not model one customer as one namespace.

### Day-2 operations

- **Version policy:** stay within the two most recent minor releases. Upgrade one minor version at a time, after reading deprecations and testing in a staging cluster.
- **Capacity:** watch requested vs allocatable resources per node; keep enough headroom to lose one worker without evictions.
- **Certificates:** Talos rotates cluster certificates; verify expiry dates quarterly anyway.

### Security and HIPAA notes

- Only PHI-handling namespaces (`chartwarden-*`, `database`, `storage`, `messaging`) may hold patient data. Observability must not ingest PHI; scrub logs at the application.
- The Kubernetes API is never exposed publicly.
- Service accounts have no token mounted unless they need one.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Pods Pending | Insufficient resources or unsatisfiable affinity | `kubectl describe pod`; add capacity or relax rules |
| CrashLoopBackOff | Bad config, missing secret, failing migration | Check logs and recent Git change; roll back in Argo CD |
| Evictions | Memory pressure | Fix requests/limits; add a node |

### Do not

- Run workloads in `default` or give anything `cluster-admin` except break-glass accounts.
- Use `hostPath`, `hostNetwork`, or privileged containers for application code.
- Edit live resources by hand; Argo CD will revert them and the change is untracked.

## 5. Cilium

**Stage 1 · Production · Networking and network policy**

### Role in ChartWarden

Cilium is the cluster network (CNI). It connects pods using eBPF, enforces which workloads may talk to which, encrypts traffic between nodes, and shows every flow through Hubble. It is the main control that stops a compromised frontend from reaching the database directly.

### Key concepts

- **eBPF datapath:** packet handling in the Linux kernel instead of iptables chains; faster and more observable.
- **CiliumNetworkPolicy:** policies by label, namespace, DNS name (FQDN), or L7 attribute (HTTP path, method).
- **Default deny:** once any policy selects a pod, all traffic not explicitly allowed is dropped.
- **Transparent encryption:** WireGuard tunnels between nodes, with no application change.
- **Hubble:** flow logs and a service map showing allowed and dropped connections.
- **kube-proxy replacement:** Cilium handles Service load balancing itself.

### Deployment baseline

- Install with kube-proxy replacement enabled (Talos is configured with no kube-proxy).
- Enable WireGuard node-to-node encryption.
- Enable Hubble relay and UI, reachable only on the management network.
- Apply a cluster-wide default-deny policy, then add allow rules per flow. Baseline allows: DNS to kube-dns, metrics scraping from `observability`, and Argo CD to the Kubernetes API.

Allowed application flows:

| From | To | Port |
| --- | --- | --- |
| Gateway | `chartwarden-prod` web and API | HTTP |
| `chartwarden-prod` API | PgBouncer (`database`) | 5432 |
| `chartwarden-prod`, `chartwarden-workers` | Valkey | 6379 |
| `chartwarden-prod`, `chartwarden-workers` | Garage S3 API | 3900 |
| `chartwarden-integration` | Named external FQDNs only | 443 |
| All PHI namespaces | OpenBao | 8200 |

Everything else, including web to database and any pod to the internet, is denied.

### Day-2 operations

- **Upgrades:** follow Cilium's documented minor-by-minor path and run its pre-flight check. Upgrade during a maintenance window; connectivity blips are possible.
- **Policy changes:** write policies in Git, test in staging with Hubble watching for drops, then promote.
- **Health:** `cilium status` and `cilium connectivity test` after every upgrade.

### Security and HIPAA notes

- WireGuard encryption covers PHI in transit inside the cluster, satisfying the transmission-security safeguard for east-west traffic.
- FQDN egress rules let integration workers reach only named partners (clearinghouse, CMS endpoints), blocking data exfiltration to arbitrary hosts.
- Hubble flow logs are evidence for access reviews; retain them per the audit policy.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Service suddenly unreachable | New or changed policy dropping traffic | `hubble observe --verdict DROPPED`; revert the policy in Git |
| DNS failures in pods | Missing DNS allow rule | Restore the baseline DNS policy |
| Cross-node traffic fails | WireGuard key or MTU problem | Check `cilium status`; review MTU settings |

### Do not

- Add a broad "allow all within namespace" rule to fix a problem quickly. Find the specific flow instead.
- Expose Hubble UI publicly.
- Add a service mesh (Istio, Linkerd) on top without a concrete need Cilium cannot meet.

## 6. Envoy Gateway and cert-manager

**Stage 1 · Production · Ingress and TLS**

**Update (2026-10-02):** Envoy Gateway is no longer the public front door. Pangolin on the edge VPS terminates public TLS and tunnels into the cluster, where Envoy Gateway routes to services. Give Envoy no public LoadBalancer IP. Current hostnames in the repo's Nginx configs are `wardenx.chartwarden.cloud`, the API host, and `storage.wardenx.chartwarden.cloud` for presigned document URLs (`STORAGE_PUBLIC_ORIGIN`); all three move behind Pangolin.

### Role in ChartWarden

Envoy Gateway is the cluster's internal ingress behind Pangolin. Per ADR-0049, every tenant is served at
`<slug>.<TENANT_BASE_DOMAIN>`, and Envoy routes each tenant host by path:

- `/api/` → the API Service
- `/portal/` → the portal SPA
- `/` → the staff SPA

Reserved exact hosts (`admin.`, `app.`, `storage.`) get their own routes. There is **no `auth.` host**: Better
Auth is mounted same-origin under `/api/auth`. Pangolin terminates the public wildcard certificate (DNS-01),
so Envoy never holds a public certificate. cert-manager issues and renews every TLS certificate automatically, so no certificate ever expires because someone forgot it. (Cilium's own Gateway API implementation is an acceptable alternative; pick one and do not run both.)

### Key concepts

- **GatewayClass / Gateway / HTTPRoute:** the Gateway API objects. The Gateway owns listeners and certificates; HTTPRoutes attach hostnames and paths to Services.
- **SecurityPolicy and BackendTrafficPolicy:** Envoy Gateway extensions for rate limits, CORS, timeouts, retries, and external auth.
- **Issuer / ClusterIssuer:** cert-manager's source of certificates, typically ACME (Let's Encrypt) with DNS-01 validation.
- **Certificate:** a desired certificate; cert-manager keeps the matching Secret valid and renews ahead of expiry.

### Deployment baseline

- Traffic path: Pangolin (public TLS, wildcard resource, `Host` preserved) → Newt tunnel → Envoy Gateway → services.
- One Gateway in `ingress` with listeners for the public hostnames only. Internal tools (Grafana, Argo CD, Harbor) get a separate internal Gateway on the management network.
- TLS 1.2 minimum, TLS 1.3 preferred; HSTS on all public hosts.
- ACME ClusterIssuer using DNS-01 through the DNS provider's API token (scoped to the ChartWarden zones, stored as a secret).
- Rate limits on `auth.` and login endpoints; request body size limits on upload routes.
- Restore the real client IP (PROXY protocol or X-Forwarded-For from trusted load balancers only) so audit events record the correct source IP.

### Day-2 operations

- Alert when any Certificate is not Ready or expires within 14 days.
- Upgrade Envoy Gateway and Gateway API CRDs together, following the project's compatibility table.
- Review HTTPRoutes quarterly for anything exposed that should not be.

### Security and HIPAA notes

- This is the boundary where PHI enters and leaves. Access logs record method, path, status, and latency, never request or response bodies, query strings with identifiers, or auth headers.
- A Service is never reachable from outside unless an HTTPRoute in Git says so.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Browser certificate error | Renewal failed (DNS token, rate limit) | `kubectl describe certificate`; check cert-manager logs and the ACME order |
| 404 on a known host | HTTPRoute not attached to Gateway | Check route status conditions |
| 503 from gateway | No ready backend endpoints | Check the target Deployment's readiness |

### Do not

- Use HTTP-01 validation for wildcard or internal hosts; use DNS-01.
- Log full request bodies, even temporarily for debugging.
- Expose internal admin UIs on the public Gateway.

## 7. PostgreSQL, CloudNativePG and PgBouncer

**Stage 1 · Production · Database (source of truth)**

**Update (2026-10-02):** The code is ready for this design. It runs as a `NOBYPASSRLS` role (`wardenx_app`), keeps a separate platform role, generates every RLS policy keyed on `app.org_id` (ADR-0010), and applies its forward-only migrations (`packages/db/migrations/`) with `bun run scripts/db/migrate.ts` plus `provision-runtime-roles.ts`. Run those as a Kubernetes Job before each rollout. The image is `pgvector/pgvector:pg18`, so the CloudNativePG image must include the pgvector extension.

### Role in ChartWarden

PostgreSQL holds every clinical, billing, and audit record. CloudNativePG (CNPG) is the Kubernetes operator that runs it: it creates the primary and replicas, fails over automatically, archives WAL, takes base backups, and performs point-in-time recovery. PgBouncer pools connections so many API and worker pods do not exhaust PostgreSQL's connection limit. This is the single most important component on the platform.

### Key concepts

- **Cluster:** the CNPG resource describing a PostgreSQL cluster: instance count, storage, parameters, backup target.
- **Primary and replicas:** one writable primary; replicas stream WAL from it. CNPG exposes `-rw` (primary), `-ro` (replicas), and `-r` (any) Services.
- **Synchronous replication:** a commit waits until at least one replica confirms it, so a primary failure loses no committed data (RPO ≈ 0).
- **WAL archiving:** continuous shipping of write-ahead log segments to object storage. Together with base backups, this enables point-in-time recovery (PITR).
- **Pooler:** CNPG's built-in PgBouncer resource.
- **Replica cluster:** a CNPG cluster in another region that follows the primary cluster's WAL archive, ready to be promoted for disaster recovery.
- **Row-level security (RLS):** PostgreSQL policies that restrict every query to the current tenant's rows.

### Deployment baseline

- Three instances, one per database node, enforced by anti-affinity across physical hosts. Dedicated NVMe local storage.
- Synchronous replication with at least one synchronous standby.
- WAL archive and daily base backups go **directly** (barman-cloud) to off-site, BAA-covered object storage with
  Object Lock, written with credentials that cannot delete, so the recovery point never depends on a copy job.
  A nightly copy into in-region Garage speeds up routine restores. Retention: 30 days of PITR minimum.
- Pooler in transaction mode for the application; a separate session-mode path for migrations and tools that need
  session features. Transaction mode is compatible with the tenancy GUC, because the code sets it with
  `set_config('app.org_id', …, true)` inside each transaction (`packages/tenancy/src/context.ts`). Prove it with
  the live RLS suites before switching the app to the pooler.
- Application roles: one owner role for migrations, one runtime role with no DDL rights, one read-only reporting role. Runtime role has RLS enforced (no `BYPASSRLS`).
- TLS required for all client connections; CNPG manages server certificates.
- `pg_stat_statements` enabled; `log_min_duration_statement` set to catch slow queries without logging parameters that contain PHI.

Targets (engineering objectives, proven only by drills):

| Scenario | RPO | RTO |
| --- | --- | --- |
| Primary pod or node failure | ≈ 0 | < 2 minutes |
| Full regional loss | < 5 minutes | < 30 minutes |
| Accidental data deletion | Point in time before the error | Hours (PITR to a new cluster) |

### Day-2 operations

- **Minor upgrades:** change the image tag; CNPG performs a rolling update, replicas first, then a switchover.
- **Major upgrades:** use a new cluster restored or imported from the old one, test, then cut over. Never in place without a rehearsal.
- **Migrations:** run as a Kubernetes Job before the application rollout, using the owner role through the session-mode path. Migrations must be backward compatible with the previous app version.
- **Restore drill (monthly):** restore the latest backup to a scratch cluster, run integrity queries (row counts, audit-chain verification), record time to restore.
- **Monitoring:** replication lag, WAL archive failures, backup age, connection saturation, disk usage, transaction ID wraparound age.

### Security and HIPAA notes

- RLS is a second tenant-isolation layer behind the application's tenant checks. Test it: a query as tenant A must return zero rows from tenant B.
- Backups contain PHI. They are encrypted, stored only on BAA-covered storage, and access to them is logged.
- Database credentials live in OpenBao from stage 1, delivered by External Secrets and rotated quarterly.
  Short-lived dynamic credentials from OpenBao's database engine are a stage-2 step.
- No one queries production directly for routine work. Break-glass access is time-limited, logged, and reviewed.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Writes failing, primary gone | Node failure | CNPG promotes a replica automatically; verify with `kubectl cnpg status` |
| Writes hang | No synchronous standby available | Restore a replica; temporarily relax sync only as a documented decision |
| WAL archive alert | Object store unreachable or full | Fix storage fast; WAL piles up on local disk |
| Too many connections | Pooler bypassed or sized wrong | Route through PgBouncer; tune pool size |
| Bad data written | Application bug or human error | PITR to a new cluster at a time before the error; copy back affected rows |

### Do not

- Run PostgreSQL as a plain StatefulSet or rely on Velero for database recovery. CNPG owns database backup and restore.
- Put the only backup copy in the same cluster or region as the database.
- Grant the application role superuser, `BYPASSRLS`, or DDL rights.

## 8. Garage

**Stage 1 · Production · S3-compatible object storage**

**Update (2026-10-02):** The code uses **one bucket per tenant** (`deriveTenantBucket` in M22), not a single `chartwarden-documents` bucket. Tenant buckets are created and destroyed through the M34 provision gateway, which does not exist yet and must call Garage's admin API. The adapter (`s3-object-store.ts`) is plain SigV4 with path-style URLs and 300-second presigned GETs, so it works with Garage by setting `MINIO_ENDPOINT` and `MINIO_REGION` (Garage's region, `garage` by default). Platform buckets (`cnpg-wal`, `cnpg-base`) stay as listed below. Local development keeps MinIO (product-owner decision, 2026-10-05). CI runs a live suite that exercises the real
adapter against a Garage container, so production's store is still tested (ADR-0050 D6).

### Role in ChartWarden

Garage stores files: signed consent forms, scanned documents, PDFs, attachments, exports, and the PostgreSQL WAL archive. It speaks the S3 API, so ChartWarden code uses an `ObjectStore` interface with a Garage adapter in the private cloud and an S3 adapter anywhere else. Garage replaces MinIO, whose open-source edition is no longer a stable foundation.

### Key concepts

- **Layout:** the map of nodes, their zones (failure domains), and capacity. Changes are staged and then applied with a version number.
- **Replication factor:** how many copies of each object exist. ChartWarden uses 3, one per zone.
- **Zones:** Garage places each copy in a different zone. Map zones to physical hosts (single region) or to sites.
- **Buckets and keys:** S3 buckets with per-key access grants (read, write, owner).
- **Metadata vs data:** metadata lives in an embedded database on fast disk; object data can sit on larger disks.

### Deployment baseline

- Three Garage nodes on three distinct physical hosts, each its own zone, replication factor 3.
- Metadata on NVMe; data on dedicated volumes.
- Buckets: one per tenant (`deriveTenantBucket`), created by the provisioning path through Garage's admin API,
  plus platform buckets such as the in-region copy of the CNPG backups. One access key per consumer, scoped to
  its buckets.
- **Application-level encryption is not built yet.** M22's renderer uploads document bytes as-is
  (`apps/backend/src/modules/22-documents/seams/renderer.ts`, `putObject`), so Garage holds **plaintext PHI**. Today
  that data is protected only by Talos disk encryption and access control. Envelope-encrypting blobs before upload,
  under the per-tenant DEK (ADR-0038), is an open gap to close before stage 1.
- S3 API reachable only inside the cluster; the admin API only on the management network.
- Garage, as far as known, does not offer S3 Object Lock. Immutable backup copies therefore go to external, BAA-covered object storage that supports Object Lock.

### Day-2 operations

- **Adding capacity:** add a node, assign zone and capacity in the layout, apply; Garage rebalances in the background.
- **Health:** `garage status` and `garage stats`; alert on any node down or resync queue growth.
- **Repairs:** run `garage repair` tasks after node replacement to verify all objects have their full copy count.
- **Upgrades:** rolling, one node at a time, after reading release notes for layout or metadata changes.

### Security and HIPAA notes

- Documents are PHI. Never put patient identifiers in object keys (the code uses opaque, PHI-free keys), log every
  access through the ChartWarden audit ledger, and close the encrypt-before-upload gap above.
- Download URLs given to browsers are short-lived presigned URLs, issued only after an authorization check.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Writes fail with quorum error | Two of three nodes down | Restore a node; reads may still succeed |
| Growing resync queue | Node slow or recently returned | Check disk and network on that node |
| Metadata corruption on one node | Disk or power fault | Wipe and re-add the node; data re-replicates from peers |

### Do not

- Put two zones on the same physical host.
- Treat Garage as the only backup location for anything.
- Expose buckets publicly or use long-lived presigned URLs.

## 9. NATS JetStream

**Deferred · not used by the current code.** ChartWarden carries cross-module events through a transactional outbox in PostgreSQL (`packages/shared/src/outbox`) and runs background work on BullMQ over Valkey. ADR-0036 records that no realtime backbone was built. Keep this chapter as reference only; adopt NATS only through a new ADR.

### Role in ChartWarden

NATS with JetStream carries domain events and background commands: `PatientAdmitted`, `HOPEAssessmentCompleted`, `ClaimSubmitted`, `DocumentSigned`, and the jobs they trigger (billing, notifications, audit fan-out). It replaces AWS SQS, SNS, and EventBridge. PostgreSQL stays authoritative; NATS only moves facts that are already committed.

### Key concepts

- **Subjects:** hierarchical topic names, e.g. `chartwarden.<tenant>.patient.admitted`. Wildcards (`*`, `>`) let consumers subscribe broadly.
- **Stream:** a durable, replicated log that captures messages on a set of subjects, with retention by age, size, or interest.
- **Consumer:** a cursor over a stream. Durable pull consumers with explicit acknowledgement are the default for workers.
- **Ack, redelivery, max deliver:** unacknowledged messages are redelivered; after the limit they go to a dead-letter path for inspection.
- **Accounts:** isolation boundaries with their own subjects and credentials.
- **Transactional outbox:** the application writes the event row in the same database transaction as the state change; a relay publishes outbox rows to NATS and marks them sent.

### Deployment baseline

- Three-node NATS cluster via the official Helm chart, JetStream enabled, file storage on fast local disks, streams with replicas 3.
- Streams by domain: `CLINICAL`, `BILLING`, `DOCUMENTS`, `NOTIFY`, `AUDIT_FANOUT`. Retention: limits-based, sized for at least 7 days of replay.
- Per-service NKey or JWT credentials with publish/subscribe permissions limited to their subjects.
- TLS on client and cluster connections.
- Message deduplication using the `Nats-Msg-Id` header set to the outbox row ID, so a relay retry never produces a duplicate event.
- Consumers are idempotent: processing the same event twice must have the same effect as once.

### Day-2 operations

- **Monitoring:** consumer lag (pending messages), redelivery counts, stream storage use, cluster health. Alert when lag grows for more than a few minutes.
- **Dead letters:** review weekly; every dead letter is either a bug to fix or a poison message to discard deliberately.
- **Upgrades:** rolling, one server at a time, checking JetStream meta-leader health between steps.
- **Disaster recovery:** streams can be mirrored to the DR region, but recovery relies on the PostgreSQL outbox: replay unsent or recent outbox rows after failover.

### Security and HIPAA notes

- Event payloads carry IDs and minimal fields, not full clinical documents. Consumers fetch details from the API or database under normal authorization.
- Streams that contain PHI live on encrypted disks and are covered by the same retention and access rules as the database.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Consumer lag climbing | Worker crashed or slow dependency | Check worker logs and downstream services; scale workers |
| Repeated redeliveries | Poison message or non-idempotent handler | Inspect message; fix handler; move to dead-letter |
| Publish fails | Stream full or quorum lost | Check storage limits and node health |
| Events missing after outage | Relay stopped | Restart relay; it resumes from unsent outbox rows |

### Do not

- Treat NATS as the system of record or rely on it for distributed transactions.
- Publish directly from request handlers without the outbox for events that matter.
- Add Kafka or RabbitMQ unless a measured need exceeds what JetStream provides.

## 10. Valkey

**Stage 1 · Required.** The worker process runs its job queues on BullMQ, and the API uses Valkey for the rate limiter. Losing Valkey stops background work such as claim submission and document processing. Run it with AOF persistence, `maxmemory-policy noeviction` (BullMQ requires it), and replication with Sentinel failover across the three nodes.

### Role in ChartWarden

Valkey, the open-source fork of Redis, holds two kinds of data:

- **The BullMQ job queues.** This is durable job state: queued claim submissions, document processing and
  scheduled work. Losing it loses queued work, so Valkey is **not** a disposable cache here.
- **Fast-to-lose data:** rate-limit counters, short-lived locks and cached reference data.

Better Auth sessions live in PostgreSQL, not Valkey. Valkey is never the source of truth for clinical data, and
every job must be idempotent and re-creatable from PostgreSQL state.

### Key concepts

- **Key TTLs:** every key expires. A key without a TTL is a bug.
- **Primary/replica with Sentinel:** one primary, replicas that follow it, and Sentinel processes that promote a replica on failure. Simpler than cluster mode and sufficient for ChartWarden's size.
- **Persistence modes:** RDB snapshots and AOF logs. For a pure cache, persistence can be off; for sessions, light persistence avoids mass logouts on restart.
- **ACLs:** per-user command and key-pattern permissions.
- **Eviction policy:** what happens at the memory limit. BullMQ **requires `noeviction`**: an evicted job key is a
  silently lost job. At the limit, writes fail loudly instead.

### Deployment baseline

- One primary and two replicas with three Sentinels, spread across nodes.
- `maxmemory` set below the container memory limit; eviction policy **`noeviction`**; AOF persistence on. Alert at
  80% memory.
- ACL users per service with key prefixes (`ratelimit:*`, `cache:*`, `lock:*`, `session:*`); default user disabled.
- TLS for client connections; password or ACL auth required.
- Key naming includes tenant ID for tenant-scoped data (`cache:<tenant>:<resource>:<id>`) so a flush or audit can target one tenant.

### Day-2 operations

- Monitor memory use, evictions, hit rate, connected clients, and replication offset.
- Test failover quarterly by killing the primary pod and confirming clients reconnect via Sentinel.
- Upgrades are rolling: replicas first, then fail over and upgrade the old primary.

### Security and HIPAA notes

- Prefer caching IDs and non-identifying reference data. If any cached value contains PHI, it needs a short TTL, encryption at rest on the node, and inclusion in the risk analysis.
- Locks used for clinical workflows (for example, preventing two clinicians from signing the same visit) must fail safe: if the lock cannot be acquired, the action is refused, not allowed.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Latency spike across API | Valkey down or evicting heavily | Check memory and evictions; application must fall back to the database |
| Jobs missing after restart | AOF off or corrupted | Re-enqueue from PostgreSQL state; confirm AOF is enabled |
| Split-brain after network blip | Sentinel misconfiguration | Verify quorum settings; keep three Sentinels on separate nodes |

### Do not

- Store clinical data in Valkey, or enqueue a job that cannot be re-created from PostgreSQL state.
- Use `KEYS *` in production; use `SCAN`.
- Share one Valkey user across all services.

## 11. OpenBao

**Stage 1 · Security and recovery.** Three-node Raft cluster, one node per server. First job: deliver every secret now in `.env.production`, above all `M34_TENANT_KEK` (wraps each tenant's data key, ADR-0045) and `M35_PSEUDONYM_KEY_KEK`. Second job: bind the code's `kekUnwrap` port (ADR-0038 §3) to the Transit engine, so the platform KEK never sits in application memory.

### Role in ChartWarden

OpenBao, the open-source fork of HashiCorp Vault, is the vault for every secret and key: database credentials, API tokens for clearinghouses and partners, signing keys, and the encryption keys that protect documents and sensitive columns. Its transit engine encrypts and decrypts data without ever revealing the key to the application. It replaces AWS KMS and Secrets Manager.

### Key concepts

- **Seal and unseal:** OpenBao starts sealed and cannot read its own storage until unsealed with key shares (Shamir) or an auto-unseal mechanism (a cloud KMS, HSM, or another OpenBao transit instance).
- **Integrated storage (Raft):** built-in replicated storage across three or five nodes; no external database needed.
- **Auth methods:** how clients prove identity. Pods use the Kubernetes auth method with their service-account token; humans use OIDC through authentik.
- **Policies:** path-based rules saying which identity may read or write which secret.
- **Secret engines:** KV (static secrets), database (dynamic, short-lived PostgreSQL credentials), PKI (internal certificates), transit (encryption as a service).
- **Leases and TTLs:** dynamic secrets expire and are revoked automatically.
- **Audit devices:** a log of every request, with sensitive values hashed.

### Deployment baseline

- Three-node Raft cluster on separate hosts, in the security domain, reachable only from PHI namespaces and the management network.
- Auto-unseal using a key held outside the production cluster (an HSM, or a separate small OpenBao transit instance in the security domain). Recovery key shares split among trusted holders and stored offline.
- Kubernetes auth with one role per service account; each role maps to a least-privilege policy.
- Database secrets engine issuing PostgreSQL credentials with a TTL measured in hours (stage 2; stage 1 uses
  static credentials in KV).
- Transit keys per purpose (`documents`, `phi-columns`, `exports`) with rotation enabled; ChartWarden stores only ciphertext and key version.
- Secrets reach pods through an injector or the External Secrets Operator, never by baking them into images or Git.
- File audit device enabled, shipped to the security log pipeline.

### Day-2 operations

- **Snapshots:** daily Raft snapshots, encrypted, stored in the immutable backup location. Restore one to a scratch instance quarterly.
- **Key rotation:** rotate transit keys on a schedule (for example annually) and rewrap stored ciphertext in the background.
- **Upgrades:** rolling, standbys first, leader last.
- **Access review:** list policies and roles quarterly; remove anything unused.

### Security and HIPAA notes

- OpenBao directly supports the HIPAA encryption and access-control safeguards and produces the key-access audit trail auditors ask for.
- Losing both the unseal mechanism and the recovery keys means losing every encrypted document. Treat recovery keys as the most important artifact in the company.
- Root tokens are generated only for emergencies and revoked immediately after.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Pods cannot start, secret fetch fails | OpenBao sealed or unreachable | Check seal status and auto-unseal key availability |
| Database login failures | Dynamic credential lease expired and not renewed | Check agent/operator logs; verify lease TTLs |
| Raft cluster has no leader | Two of three nodes down | Restore nodes; as last resort, restore from snapshot |

### Do not

- Keep the auto-unseal key inside the cluster it unseals.
- Use one broad policy for all services.
- Leave root tokens alive or store them anywhere digital.

## 12. authentik

**Stage 2 · Security and recovery · Administrator single sign-on**

**Update (2026-10-02):** authentik is for staff and admin access to platform tools through Pangolin. Hospice users sign in to ChartWarden itself through Better Auth (ADR-0033), which stays as is.

### Role in ChartWarden

authentik is the identity provider for people who operate the platform: one login, with phishing-resistant MFA, for Grafana, Argo CD, Harbor, Forgejo, OpenBao, and Hubble. It does not authenticate hospice staff using ChartWarden; that stays behind ChartWarden's own authentication layer (Better Auth), so the EHR is not coupled to infrastructure identity.

### Key concepts

- **Providers:** OIDC/OAuth2, SAML, LDAP, SCIM, or proxy configurations that connect authentik to an application.
- **Applications:** the tools users log into, each bound to a provider.
- **Flows and stages:** configurable login sequences (identification, password, WebAuthn, consent).
- **Outposts:** small proxies that put authentik in front of tools with no native SSO.
- **Groups:** map to roles in downstream tools (for example `platform-admins`, `readonly`).

### Deployment baseline

- Deployed in `identity` with its own CNPG PostgreSQL cluster (small) and a Valkey or built-in cache.
- Reachable only through the internal Gateway on the management network.
- Authentication flow requires WebAuthn (hardware key or platform passkey) for every admin; no SMS or email codes.
- OIDC integrations: Grafana, Argo CD, Harbor, Forgejo, OpenBao (OIDC auth method). Groups map to least-privilege roles in each.
- Two break-glass local accounts per critical tool (Argo CD, OpenBao), credentials sealed offline, use alerted.

### Day-2 operations

- Back up authentik's database with CNPG like any other cluster.
- Review users and group memberships quarterly; remove departed people the same day.
- Upgrade on each release's documented path; authentik moves fast, so do not fall more than a few versions behind.

### Security and HIPAA notes

- Supports the HIPAA person-authentication and unique-user-identification safeguards for workforce access to systems holding PHI.
- authentik's event log records logins and admin changes; ship it to the security log pipeline.
- If authentik is down, break-glass accounts are the only path in. Test them twice a year.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Cannot log into any admin tool | authentik down | Use break-glass account; restore authentik |
| Login works but no permissions | Group mapping or claim changed | Check provider scope mappings and group claims |

### Do not

- Use authentik as the login for ChartWarden end users.
- Allow password-only admin logins, even temporarily.
- Expose authentik to the public internet.

## 13. Forgejo and CI runners

**Stage 1 (CI runners) / Stage 2 (Forgejo) · Software factory · Source control and CI**

**Update (2026-10-02) · open decision.** The repo runs on GitHub Actions (`ci.yml`, `deploy.yml`), publishes to GHCR, and signs images with keyless Cosign bound to the GitHub workflow identity. The current plan is a self-hosted GitHub runner on the Hostinger VPS. Moving to Forgejo means re-anchoring that signing identity, so decide before building this chapter.

### Role in ChartWarden

Forgejo is a self-hosted Git forge (a community fork of Gitea) for the ChartWarden application and infrastructure repositories. Forgejo Actions runs CI pipelines using GitHub Actions-compatible workflow syntax; Woodpecker CI is an alternative. In stage 1, the repositories can stay on GitHub with self-hosted runners; moving to Forgejo is about owning the whole software factory, not a prerequisite for production.

### Key concepts

- **Organizations and repositories:** `chartwarden/app`, `chartwarden/infrastructure`, `chartwarden/gitops` (the manifests Argo CD watches).
- **Branch protection:** required reviews, required status checks, signed commits, no force-push to `main`.
- **Runners:** separate processes that execute jobs, ideally in ephemeral containers or VMs that are destroyed after each job.
- **Workflow secrets:** values injected into jobs; scoped per repository and environment.

### Deployment baseline

- Forgejo in the software-factory domain, separate from the production cluster, with its own PostgreSQL and backups.
- SSO through authentik; WebAuthn required.
- Runners are ephemeral: each job starts clean, has no persistent credentials, and cannot reach production networks.
- The `gitops` repository is the only path to production. Merges to its `main` branch require review and passing checks.
- CI never uses real PHI. Integration tests use synthetic patients generated by fixtures.

Standard pipeline:

1. Lint, type-check, unit tests
2. Gitleaks secret scan and Semgrep SAST
3. Integration tests against ephemeral PostgreSQL, Valkey and Garage (and Floci where AWS adapters are under test)
4. Build container image
5. Syft SBOM, Trivy/Grype vulnerability scan, license check
6. Push to Harbor, sign with Cosign
7. Open a PR on the `gitops` repo bumping the image digest

### Day-2 operations

- Back up Forgejo's database and repository storage daily; restore test quarterly.
- Rotate runner registration tokens; keep runner images patched.
- Keep CI duration under about 10 minutes so the pipeline is not bypassed.

### Security and HIPAA notes

- A compromised runner must not be able to deploy. It can only push a signed image and open a PR; a human merges it.
- AI coding agents work here: they write code and open PRs. They never receive production credentials.
- The current Hostinger VPS is acceptable for CI runners only because CI never touches PHI.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Jobs stuck queued | Runner offline or out of capacity | Check runner registration and host resources |
| Pipeline green but image unsigned | Signing step skipped on a branch | Kyverno blocks it at deploy; fix workflow |
| Secret found in a commit | Gitleaks hit | Rotate the secret first, then rewrite history if needed |

### Do not

- Give runners kubeconfigs or credentials for production.
- Load production data dumps into CI or developer machines.
- Allow direct pushes to `main` on any repository.

## 14. Harbor

**Stage 2 · Software factory · Container registry**

**Update (2026-10-02):** Images are in GHCR today, already scanned with Trivy, described with a Syft SBOM, and signed with Cosign by the release workflow. Harbor stays stage 2; nothing blocks go-live on it.

### Role in ChartWarden

Harbor is the private registry for every container image and Helm chart ChartWarden runs. It scans images for vulnerabilities, stores signatures and SBOMs beside them, replicates images to the DR region, and caches upstream images so production never pulls from Docker Hub at deploy time. It replaces AWS ECR or GitHub Container Registry.

### Key concepts

- **Projects:** groups of repositories with their own access, quotas, and policies (`chartwarden`, `platform`, `proxy-dockerhub`).
- **Robot accounts:** non-human credentials with narrow scopes (push for CI, pull for the cluster).
- **Proxy cache projects:** pull-through caches for public registries.
- **Replication rules:** push or pull images to another Harbor (the DR region).
- **Tag immutability and retention:** stop tags being overwritten; clean up old artifacts.
- **OCI artifacts:** signatures (Cosign) and SBOMs stored as artifacts attached to the image digest.

### Deployment baseline

- Harbor in the software-factory domain with external PostgreSQL (CNPG) and Garage or local storage for blobs.
- Projects: `chartwarden` (application images, private), `platform` (mirrored platform images pinned by digest), proxy caches for Docker Hub, GHCR, and Quay.
- Tag immutability on `chartwarden`; deployments reference images by digest anyway.
- Built-in Trivy scanning on push; policy prevents pulls of images with critical vulnerabilities that have a fix available.
- CI robot: push only to `chartwarden`. Cluster robot: pull only.
- Replication of `chartwarden` and `platform` to the DR Harbor on every push.
- SSO via authentik.

### Day-2 operations

- Run garbage collection on a schedule after retention policies remove old tags.
- Watch storage growth and replication job failures.
- Back up Harbor's database and configuration; image blobs can be rebuilt from Git but restores are faster than rebuilds.

### Security and HIPAA notes

- Images never contain PHI, secrets, or production config. Gitleaks and Trivy's secret scanner check this.
- If production cannot pull, it cannot recover pods. Harbor's availability matters during incidents; replication to DR covers regional loss.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| `ImagePullBackOff` | Harbor down, robot token expired, or image blocked by policy | Check Harbor health and robot expiry; check scan results |
| Replication lagging | Network or DR Harbor issue | Inspect replication job logs |
| Disk full | Garbage collection not running | Run GC; adjust retention |

### Do not

- Deploy by mutable tag (`:latest`, `:main`).
- Let the cluster pull directly from public registries in production.
- Share one robot account between CI and the cluster.

## 15. Argo CD

**Stage 1 · Production · GitOps delivery**

**Update (2026-10-02):** The repo has no Kubernetes manifests or Helm chart. It deploys with Docker Compose over SSH (`deploy/production/deploy.sh`). Before Argo CD has anything to sync, write manifests for the `api`, `worker` and `web` processes, the migration Job, and the smoke test (`smoke.sh`, four tiers) as a post-sync hook.

### Role in ChartWarden

Argo CD is the only thing that changes production. It watches the `gitops` repository and continuously makes the cluster match it: new image digests, configuration changes, platform upgrades. Every production change is therefore a reviewed Git commit with an author, a timestamp, and a diff, which doubles as the change-management record.

### Key concepts

- **Application:** a mapping from a Git path (Helm chart, Kustomize overlay, or plain manifests) to a cluster and namespace.
- **ApplicationSet:** a generator that creates many Applications from a template, for example one per platform component or per region.
- **Sync and health:** sync status says whether live state matches Git; health says whether the resources are working.
- **Auto-sync, self-heal, prune:** automatically apply Git changes, revert manual drift, and delete resources removed from Git.
- **Sync waves and hooks:** order resources (CRDs before operators, migrations before app rollout).
- **AppProject:** limits which repos, clusters, and namespaces an Application may touch.

### Deployment baseline

- Argo CD in `gitops`, UI on the internal Gateway only, reached through Pangolin's authentication. SSO via authentik
  arrives at stage 2. Local admin is disabled after setup (break-glass kept sealed).
- App-of-apps or ApplicationSet structure: `platform/*` (Cilium, CNPG, Garage, OpenBao, External Secrets, Kyverno,
  observability) and `apps/chartwarden`.
- Auto-sync with self-heal. Prune is on for app resources and **off** for data services (CNPG `Cluster`, Garage,
  OpenBao), so a bad commit can never delete a database (ADR-0050 D4). The production app syncs only after the
  `gitops` PR merges.
- Sync waves: CRDs and operators → databases and storage → migration Job (PreSync hook) → application → smoke-test Job (PostSync hook).
- AppProjects restrict `apps/chartwarden` to `chartwarden-*` namespaces; only the platform project can touch cluster-scoped resources.
- Notifications to the alert channel on sync failure or degraded health.

### Day-2 operations

- **Rollback:** revert the commit in `gitops`; Argo CD syncs the previous state. Avoid UI rollbacks, which drift from Git.
- **Upgrades:** Argo CD manages its own manifests too; upgrade through Git like everything else, one minor version at a time.
- **Drift review:** any Application showing OutOfSync without a pending commit means someone changed production by hand. Investigate.

### Security and HIPAA notes

- The `gitops` repository history is an auditable change log for the HIPAA security-management and configuration-control safeguards.
- Argo CD holds powerful cluster credentials. Restrict UI access to a small admin group and disable "exec" and terminal features in the UI.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Sync failed | Invalid manifest or policy rejection (Kyverno) | Read the sync error; fix in Git |
| App Degraded after sync | New version unhealthy | Revert commit; investigate in staging |
| Argo CD itself down | Pod or repo-server failure | Cluster keeps running last state; restore Argo CD from its manifests |

### Do not

- Use `kubectl apply` or `helm upgrade` against production by hand.
- Store plaintext secrets in the `gitops` repo.
- Give the CI system write access to the cluster "just to speed things up".

## 16. Supply-chain toolchain

**Stage 1 (scanners, Renovate) / Stage 2 (signing, SBOM attestation) · Software factory**

### Role in ChartWarden

These tools make sure every release is built from known code and dependencies, contains no secrets or known critical vulnerabilities, and can be proven to come from the ChartWarden pipeline. They run as CI steps; Kyverno enforces their results at deploy time.

| Tool | Job | Runs | Blocks the build when |
| --- | --- | --- | --- |
| Gitleaks | Finds secrets in code and history | Pre-commit hook and every CI run | Any secret detected |
| Semgrep | Static analysis for code-level vulnerabilities | Every CI run | High-severity finding in changed code |
| Trivy | Scans images, filesystems, IaC, and secrets for known issues | Every CI run, and in Harbor on push | Critical vulnerability with an available fix; IaC misconfiguration of high severity |
| Syft | Generates an SBOM (SPDX or CycloneDX) for each image | Every image build | Never blocks; output is attached to the image |
| Grype | Matches the SBOM against vulnerability databases | Every image build and nightly on deployed images | Same threshold as Trivy |
| Cosign | Signs image digests and attaches attestations (SBOM, provenance) | After scans pass | Signing fails (build is not published) |
| Renovate | Opens PRs to update dependencies, base images, Helm charts | Scheduled, weekly | Never blocks; PRs go through the normal pipeline |

### Key concepts

- **SBOM:** a full inventory of packages inside an image. Lets you answer "are we affected?" within minutes when a new CVE lands.
- **Signature and attestation:** a Cosign signature proves the image came from the ChartWarden pipeline; attestations attach signed metadata (SBOM, build provenance).
- **Keyless vs key-based signing:** keyless uses short-lived certificates from an OIDC identity; key-based uses a long-lived key. For a self-hosted factory, key-based signing with the key held in OpenBao is simpler to operate.
- **Vulnerability exceptions:** a documented, time-limited acceptance of a known issue, with a reason and an expiry date.

### Deployment baseline

- Pin each tool's version in CI and update them through Renovate like any dependency.
- Keep scanner databases cached in CI but refreshed daily.
- **Today:** keyless Cosign bound to this repository's `deploy.yml` GitHub workflow identity, so no signing key
  exists to steal. Key-based signing, with the key in OpenBao transit, applies only if CI moves to Forgejo
  (chapter 13); CI would then request signatures and never see the private key.
- Keep an exceptions file in the repository with owner, reason, and expiry for each accepted finding.
- Renovate groups minor and patch updates weekly; major updates arrive as separate PRs.

### Day-2 operations

- Triage new findings weekly; nightly Grype scans of deployed images catch CVEs published after the image was built.
- Review expired exceptions monthly.
- When a major CVE is announced, query SBOMs to list affected images, patch, rebuild, and redeploy through Git.

### Security and HIPAA notes

- These controls produce evidence for the HIPAA risk-management safeguard and for customer security questionnaires (SBOMs are increasingly requested by health systems).
- A blocked build is working as intended. Bypasses require a recorded exception, not a disabled step.

### Do not

- Mark the scanning steps as "allowed to fail".
- Keep the signing key in CI secrets.
- Merge Renovate PRs without the full pipeline passing.

## 17. Kyverno

**Stage 1 (signature and digest policies, Enforce) / Stage 2 (remaining policies) · Production · Admission policy**

**Update (2026-10-05):** once deploys move to Argo CD, admission is the only place the image signature is checked.
`deploy.sh` checks it today (F-040). The signature and digest-pinning policies are therefore stage 1, enforced from
the first production sync.

### Role in ChartWarden

Kyverno checks every resource before Kubernetes accepts it. If a Deployment uses an unsigned image, runs as root, lacks resource limits, or pulls from an unapproved registry, Kyverno rejects it and the workload never runs. It turns this manual's rules into enforced code, so they hold even when someone is tired or an agent-written manifest slips through review.

### Key concepts

- **ClusterPolicy / Policy:** rules written as Kubernetes YAML, cluster-wide or per namespace.
- **Validate, mutate, generate, verifyImages:** reject bad resources, add defaults, create companion resources (such as a default NetworkPolicy), verify image signatures.
- **Audit vs Enforce:** audit mode reports violations without blocking; enforce mode blocks.
- **PolicyReports:** results of background scans of existing resources.
- **PolicyExceptions:** narrowly scoped, named exceptions for specific resources.

### Deployment baseline

Production policies, enforced in all `chartwarden-*`, `database`, `storage`, `messaging`, and `cache` namespaces:

| Policy | Rule |
| --- | --- |
| Signed images only | Keyless signature verified against the pinned identity: this repository's `deploy.yml` on `main` (a key, if CI moves to Forgejo) |
| Approved registries | GHCR today; Harbor from stage 2 |
| Digest pinning | Image references must include `@sha256:` |
| No privilege | No privileged containers, no privilege escalation, no added capabilities |
| Non-root | `runAsNonRoot: true` |
| Read-only root filesystem | `readOnlyRootFilesystem: true`, writable paths via `emptyDir` |
| Seccomp | `RuntimeDefault` profile required |
| No host access | No `hostPath`, `hostNetwork`, `hostPID`, `hostIPC` |
| Resources | CPU and memory requests and memory limits required |
| Labels | `app`, `team`, `data-class` labels required (`data-class: phi` marks PHI workloads) |

- Roll out each new policy in Audit for one week, fix violations, then switch to Enforce.
- Platform namespaces that legitimately need privileges (Cilium, Falco) get named PolicyExceptions, reviewed quarterly.
- Kyverno itself runs with three replicas; its webhook failure policy is set so that critical namespaces fail closed.

### Day-2 operations

- Review PolicyReports weekly for audit-mode violations.
- Test policy changes with the Kyverno CLI in CI against the `gitops` manifests before merging.
- Upgrade Kyverno through Argo CD; check for policy-schema changes in release notes.

### Security and HIPAA notes

- Kyverno is the enforcement point of the trust-domain design: an image that did not come through the signed pipeline cannot run in production, even if someone gains cluster credentials.
- Policy definitions and reports are evidence for configuration-management controls.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Deployment rejected | Policy violation | Read the admission error; fix the manifest |
| All admissions failing | Kyverno webhook unavailable | Restore Kyverno pods; do not delete the webhook except as a logged emergency step |
| Signature check failing for valid image | Key rotated or attestation missing | Confirm the signing key in the policy matches CI |

### Do not

- Leave policies in Audit mode permanently.
- Create broad exceptions (whole namespaces) to unblock one workload.
- Delete the admission webhook to get a deploy through.

## 18. Falco

**Stage 3 · Security and recovery · Runtime threat detection**

### Role in ChartWarden

Falco watches what containers actually do at runtime, using kernel events through eBPF, and raises alerts when behavior looks like an attack: a shell spawned in an API pod, a binary that was not in the image, writes to `/etc`, an unexpected outbound connection, or a process reading credential files. Kyverno decides what may start; Falco watches what it does after starting.

### Key concepts

- **Rules:** conditions on system calls and Kubernetes metadata, with a priority (from Debug to Emergency) and an output message.
- **Macros and lists:** reusable rule fragments, used to tune rules to ChartWarden's normal behavior.
- **Drivers:** modern eBPF probe (default on recent kernels) observes system calls with no kernel module.
- **Falcosidekick:** forwards alerts to chat, email, Loki, Wazuh, or webhooks.

### Deployment baseline

- DaemonSet on every node with the modern eBPF driver; runs in `security` under a named Kyverno exception (it needs privileges).
- Start with the default ruleset, then add ChartWarden rules: no shells in `chartwarden-*` pods, no outbound connections from `database` except to replicas and the backup target, no reads of service-account tokens by application processes.
- Falcosidekick forwards Warning and above to the alert channel and all events to Loki (stage 3: also Wazuh).
- Tune noise for two weeks before paging on any rule.

### Day-2 operations

- Review alert volume weekly; every noisy rule is either tuned with a specific exception or fixed at the source.
- Update rules with each Falco release; test custom rules in staging.

### Security and HIPAA notes

- Supports the HIPAA information-system-activity review and security-incident procedures with real-time evidence.
- A Critical Falco alert in a PHI namespace starts the incident-response runbook: isolate the pod with a deny-all policy, preserve evidence, then investigate.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| No events from a node | Driver failed to load after kernel/Talos upgrade | Check Falco pod logs; confirm driver compatibility |
| Alert flood | Untuned rule or a real incident | Check whether it is new behavior before suppressing |

### Do not

- Disable a rule because it is noisy without understanding why.
- Route Falco alerts only to a log nobody reads.

## 19. Observability: OpenTelemetry, Prometheus, Alertmanager, Grafana, Loki, Tempo

**Stage 1 (metrics, logs, alerts, dashboards) / Stage 2 (traces) · Production**

**Update (2026-10-02):** Until this stack is running, Beszel and Uptime Kuma on a monitoring VPS outside OVH cover host metrics and endpoint checks. Uptime Kuma checks the public URL through Pangolin, so it catches an edge or OVH failure that in-cluster monitoring would miss.

### Role in ChartWarden

This stack answers "is ChartWarden healthy, and if not, why?" OpenTelemetry instruments the application once in a vendor-neutral way; Prometheus stores metrics; Loki stores logs; Tempo stores traces; Alertmanager routes alerts; Grafana shows all of it in one place. It is operational telemetry, not the HIPAA audit trail, which lives in ChartWarden's own audit ledger.

| Component | Stores or does | ChartWarden use |
| --- | --- | --- |
| OpenTelemetry SDK + Collector | Instruments code; receives, processes, and exports telemetry | Fastify/Go services emit traces, metrics, logs; the Collector scrubs attributes and routes data |
| Prometheus | Time-series metrics, scraped from targets | Request rates, error rates, latency, queue lag, database and node health |
| Alertmanager | Deduplicates, groups, silences, routes alerts | Pages for user-facing outages; tickets for slow-burn issues |
| Grafana | Dashboards and exploration across all sources | Service overview, database, BullMQ queues, Garage, cluster, SLO dashboards |
| Loki | Log storage indexed by labels only | Application and platform logs, Kubernetes audit log, gateway access logs |
| Tempo | Distributed traces stored in object storage | Follow one request from gateway through API, database, and workers |

### Key concepts

- **Golden signals:** latency, traffic, errors, saturation. Every service dashboard shows these four.
- **SLO and error budget:** a target such as "99.9% of API requests succeed in under 1 second over 30 days"; alerts fire on budget burn rate, not on single spikes.
- **Labels and cardinality:** Prometheus and Loki index by labels. Never put user IDs, patient IDs, or request IDs in labels; they explode storage and can leak identifiers.
- **Trace context:** a trace ID propagated through HTTP headers and job payloads links every step of one operation.

### Deployment baseline

- kube-prometheus-stack (Prometheus Operator, Alertmanager, Grafana, node and kube-state exporters) in `observability`.
- Loki in simple scalable or monolithic mode with chunks in Garage; Tempo with traces in Garage.
- OpenTelemetry Collector as a gateway Deployment: receives OTLP from apps, runs attribute-scrubbing processors, exports to Prometheus, Loki, Tempo.
- Retention: metrics 30 days locally; logs 30 to 90 days; traces 7 to 14 days. Security-relevant logs follow the longer audit retention in the security domain.
- Grafana SSO via authentik, on the internal Gateway only.
- Alert routes: critical (page) for API down, database primary unavailable, backup or WAL archive failing, certificate expiring within 7 days; warning (ticket) for disk above 80%, consumer lag, replication lag.

### Day-2 operations

- Review alerts monthly: delete alerts nobody acts on, tune ones that fire falsely.
- Watch the monitoring stack's own health with a dead-man's-switch alert: an always-firing alert that pages if it stops arriving.
- Check label cardinality and log volume monthly; they drive storage cost.

### Security and HIPAA notes

- **No PHI in telemetry.** The application logs IDs and outcomes, never names, dates of birth, diagnoses, notes, or request bodies. The Collector's scrubbing processor is a second line of defence, not the first.
- Treat observability data as sensitive anyway: it reveals usage patterns and IP addresses. Access is restricted to platform admins.
- Separate the ChartWarden audit ledger (who accessed which patient record, append-only, hash-chained) from these logs. Auditors and patients' access-report requests are served from the ledger.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Dashboards empty | Prometheus or data source down | Check pods and Grafana data-source status |
| Loki queries slow or failing | High-cardinality labels or oversized queries | Narrow time range; fix labels at source |
| Silent outage (no alerts) | Alertmanager down or routing broken | Dead-man's-switch catches this; test routes after changes |

### Do not

- Log PHI, even at debug level, even "temporarily".
- Use patient or user identifiers as metric or log labels.
- Add Elasticsearch or a commercial APM without a concrete need.

## 20. Wazuh

**Stage 3 · Security and recovery · SIEM and security monitoring**

### Role in ChartWarden

Wazuh collects security events from across the platform, correlates them against rules, and keeps a searchable, long-retention security record. Where Falco catches suspicious behavior inside containers, Wazuh connects the dots across sources: repeated failed admin logins in authentik, followed by an OpenBao policy change, followed by an Argo CD sync. It runs in the security domain, so a production compromise cannot erase the evidence.

### Key concepts

- **Manager:** analyzes incoming events against decoders and rules and raises alerts.
- **Indexer and dashboard:** store and search events (based on OpenSearch).
- **Agents vs agentless ingestion:** Talos nodes do not run traditional agents, so ChartWarden feeds Wazuh by log forwarding (syslog or a collector) rather than host agents.
- **Rules and levels:** severity from 0 to 15; custom rules map ChartWarden-specific events.
- **Compliance mappings:** built-in tags that map rules to frameworks, including HIPAA.

### Deployment baseline

- Single-node or small cluster deployment in the security domain, on infrastructure separate from production, covered by the same BAA provider.
- Sources: Kubernetes API audit log, Talos logs, Cilium/Hubble drops, Falco (via Falcosidekick), OpenBao audit device, authentik events, Envoy Gateway access logs, Argo CD events, CNPG/PostgreSQL authentication logs.
- Ingestion is one-way from production to the security domain; production has no credentials to modify or delete Wazuh data.
- Retention aligned with the audit policy (HIPAA documentation retention is six years; decide event retention with counsel and keep at least one year searchable).
- Custom rules: break-glass account use, OpenBao root-token creation, policy exceptions created, admin login from a new country, Kyverno webhook deleted.

### Day-2 operations

- Review high-severity alerts daily, the summary weekly.
- Size and monitor indexer storage; archive older indices to immutable storage.
- Upgrade manager, indexer, and dashboard together on the documented path.

### Security and HIPAA notes

- Supports the HIPAA audit-controls and information-system-activity-review safeguards and gives incident responders a single timeline.
- Wazuh data contains IPs, usernames, and possibly resource identifiers; restrict access to security administrators.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| A source goes quiet | Forwarder broken or source changed format | Alert on missing-source heartbeats; fix decoder or forwarder |
| Indexer disk full | Retention too long for capacity | Archive older indices; add storage |

### Do not

- Run Wazuh inside the production cluster it is watching.
- Adopt it before stage 3 if no one has time to read its alerts; an unread SIEM gives false comfort.

## 21. Velero

**Stage 1 · Security and recovery · Kubernetes resource and volume backup**

### Role in ChartWarden

Velero backs up Kubernetes objects (and, where needed, persistent volumes) to object storage and restores them into the same or a new cluster. It covers what Git does not: live state such as operator-created resources, PVC data for non-database components, and namespace snapshots before risky changes. It does not back up PostgreSQL; CloudNativePG owns that.

### Key concepts

- **Backup and Schedule:** a one-time or recurring backup selecting namespaces or labels.
- **BackupStorageLocation:** the S3-compatible bucket where backups land.
- **Volume backup:** file-level backup of PVC contents via Kopia, or CSI snapshots where the storage driver supports them.
- **Restore:** recreate selected resources; can remap namespaces for drills.

### Deployment baseline

- Backup location: an off-cluster, BAA-covered bucket with Object Lock, written with credentials that cannot delete objects.
- Daily schedule for all namespaces' resources, 30-day retention; exclude `database` volumes (CNPG handles them).
- Volume backups only for stateful components without their own backup (for example Grafana if it keeps local state, authentik media).
- Pre-change backups: take a manual backup of affected namespaces before major upgrades.
- Velero backups are encrypted at rest by the storage provider and, for volume data, by Kopia's repository encryption.

### Day-2 operations

- Alert when the latest backup is older than 26 hours or ends `PartiallyFailed`.
- Quarterly drill: restore a namespace into a scratch cluster and confirm it starts.
- Keep Velero's own configuration in Git so it can be reinstalled in an empty cluster first during recovery.

### Security and HIPAA notes

- Resource backups may contain Secrets. Until OpenBao is in place, treat Velero backups as containing credentials and protect them accordingly.
- Immutable storage ensures an attacker with cluster access cannot delete the recovery path.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Backup PartiallyFailed | A volume or resource could not be read | `velero backup describe --details`; fix the failing item |
| Restore fails on CRDs | Operator not installed yet | Restore CRDs and operators first (via Argo CD), then the rest |

### Do not

- Rely on Velero for PostgreSQL recovery.
- Store Velero backups in the same Garage cluster that runs in production.

## 22. OpenTofu and Ansible

**Stage 1 · Software factory · Infrastructure as code**

### Role in ChartWarden

OpenTofu, the open-source fork of Terraform, declares everything outside Kubernetes: servers, networks, firewalls, DNS records, load balancers, and object-storage buckets at the hosting provider. Ansible covers the few imperative tasks OpenTofu cannot express well, such as bootstrapping a bare-metal server into Talos maintenance mode or configuring a WireGuard bastion. Together with Talos configs and the `gitops` repo, they make the whole cloud rebuildable from Git.

### Key concepts

- **Providers:** plugins that talk to an API (OVHcloud, DigitalOcean, Cloudflare, Talos).
- **State:** OpenTofu's record of what it manages. It contains resource IDs and sometimes secrets.
- **State encryption:** OpenTofu can encrypt state natively, which Terraform's open-source edition does not.
- **Plan and apply:** `tofu plan` shows the diff; `tofu apply` makes it real.
- **Modules:** reusable building blocks (a region, a node pool, a DNS zone).
- **Ansible inventories and playbooks:** host lists and idempotent task sequences.

### Deployment baseline

Repository layout:

```
infrastructure/
  tofu/
    modules/        region, node-pool, dns, firewall, bucket
    envs/
      test/         Hostinger cluster (stage 0; later the playground)
      primary/      OVHcloud Oregon region
      dr/           East region
      factory/      Forgejo, Harbor, runners
      security/     OpenBao, Wazuh, backup buckets
  ansible/
    bootstrap-talos.yml
    bastion.yml
  talos/
    base/ patches/
```

- Remote state in an encrypted, versioned bucket, with OpenTofu state encryption enabled and a lock mechanism. One state per environment so a mistake in one cannot destroy another.
- Provider credentials from OpenBao or encrypted files, never in the repo.
- Every change goes through a PR showing the `tofu plan` output; apply runs from a controlled runner after merge, not from a laptop.
- `prevent_destroy` lifecycle rules on database nodes, backup buckets, and DNS zones.

### Day-2 operations

- Run a scheduled `tofu plan` nightly to detect drift (manual changes in the provider console).
- Upgrade providers through Renovate PRs; read the plan carefully after provider upgrades.
- Rebuild drill (yearly): stand up a full environment from the repository into a fresh account or region.

### Security and HIPAA notes

- Infrastructure code is the documented, reviewable configuration baseline auditors ask for.
- State files can expose IPs and identifiers; restrict access to the state bucket to the apply runner and break-glass admins.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Plan wants to destroy and recreate a server | Changed immutable attribute or provider upgrade | Stop; investigate before applying |
| State lock stuck | Interrupted apply | Confirm no apply is running, then force-unlock |
| Drift detected | Manual console change | Import it into code or revert it |

### Do not

- Apply from a personal laptop to production.
- Store state unencrypted or in Git.
- Click-ops in the provider console without recording the change in code.

## 23. Floci

**Dev/CI only · Software factory · Local AWS API emulation**

**Update (2026-10-05):** The code uses the PostgreSQL outbox and BullMQ on Valkey, not NATS. Local development keeps
MinIO, and CI runs a Garage live suite so production's store is still exercised.

### Role in ChartWarden

Floci emulates AWS service APIs (such as S3, SQS, and SNS) locally, so code paths that talk to AWS can be tested on a laptop or in CI without an AWS account or bill. In ChartWarden it has one narrow job: testing the AWS adapters behind ChartWarden's portability interfaces (`ObjectStore`, event bus) for customers or deployments that may run on AWS. It is never part of production.

### Where it fits

| Environment | Object storage | Messaging | Cache | AWS adapters tested with |
| --- | --- | --- | --- | --- |
| Developer laptop | MinIO (container) | Outbox + BullMQ | Valkey | Floci, when working on adapters |
| CI integration tests | MinIO, plus a Garage live suite | Outbox + BullMQ | Valkey | Floci, in a dedicated adapter-test job |
| Production | Garage | Outbox + BullMQ | Valkey | Not present |

The main test suite runs against the same kinds of components production uses. Emulating a broker production does not run would test the wrong thing.

### Deployment baseline

- Run Floci as a container in the local Compose file and as an ephemeral service in the CI adapter-test job; destroy it after each run.
- Point the AWS SDK at Floci's endpoint through configuration, never through code branches.
- Contract tests: the same test suite runs against both adapters (Garage and Floci S3) to prove they behave the same for the operations ChartWarden uses.
- Pin the Floci version; confirm which AWS APIs and features it supports against its documentation before relying on them.

### Security and HIPAA notes

- Only synthetic data ever goes into Floci.
- An emulator passing a test does not prove a real AWS deployment is configured securely; a real AWS deployment needs its own review under an AWS BAA.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Adapter test passes locally, fails on real AWS | Emulator behavior differs from AWS | Note the gap; add a test against a real sandbox account if that path matters |
| Unsupported API error | Feature not emulated | Check Floci's supported-feature list; mock that call instead |

### Do not

- Deploy Floci to any environment that handles PHI.
- Make the main test suite depend on Floci instead of the components production actually runs.

## 24. Compliance management: Probo or Comp AI

**Stage 1 (HIPAA policies and risk analysis now) · Software factory host · Compliance program system of record**

### Role in ChartWarden

A compliance platform is the system of record for the compliance program itself: policies, the risk register, controls, vendors (including BAAs), evidence, and audit preparation. It replaces a commercial platform such as Vanta or Drata. It does not replace the security tools in this manual; it tracks the evidence they produce. Two open-source options fit ChartWarden's self-hosted direction: Probo and Comp AI.

### Key concepts

- **HIPAA is not a certification.** There is no HIPAA equivalent of a SOC 2 report. What hospice customers ask for first is a signed BAA from ChartWarden, a completed security questionnaire, and evidence of a HIPAA risk analysis and written policies. That is the first job for this tool.
- **SOC 2 comes later.** A SOC 2 Type I or Type II report is issued by an independent CPA firm. The platform organizes the evidence; the auditor is a separate cost, paid only when a customer requires the report.
- **Controls and evidence.** A control is a commitment ("backups are restored monthly"); evidence proves it operates (the restore drill output). One control can satisfy several frameworks.
- **In audit scope.** A self-hosted compliance platform becomes part of what an auditor reviews, so it needs the same access control, backups, and patching as everything else.

### Choosing the tool

|  | Probo | Comp AI | Openlane |
| --- | --- | --- | --- |
| License | MIT | Open core: about 99% AGPLv3, enterprise directory commercial | Apache 2.0 |
| HIPAA | Yes | Yes | Listed; some frameworks are paid licensed content |
| Automation interface | Web console, CLI, GraphQL API, MCP API | Web app, integrations | GraphQL API |
| Evidence automation | Collection and access reviews | Strongest SOC 2 workflow and integrations | Automated checks still on the roadmap |
| Paid option | Optional compliance-officer service | Managed plans and bundled audit, priced by quote | Hosted service and licensed frameworks |
| Fit for ChartWarden | Best fit for agent-driven work and the simplest license | Best fit if SOC 2 workflow polish matters most | Watch; not yet mature enough |

Recommendation: **Probo**, because Fable can maintain the risk register, controls, and evidence through its MCP and GraphQL APIs, and its MIT license carries no copyleft obligations. Choose Comp AI instead if its SOC 2 workflow proves stronger during a pilot. Do not run both.

### Deployment baseline

- Runs on the **software-factory host** beside Forgejo (manual chapter 13), never on the production cluster: it must keep working when production is down, and it must not share a failure domain with what it audits.
- Docker Compose deployment, pinned version, its own PostgreSQL database, configuration as code in `ansible/compliance/`.
- Reachable only over the management network (Pangolin), with MFA; SSO via authentik once it exists.
- **No PHI, ever.** Evidence screenshots, exports, and logs attached as evidence must be checked for patient data before upload. Synthetic data only in examples.
- Daily encrypted backup to the off-site bucket (separate prefix, no-delete token), restored quarterly.

### Evidence sources already in the platform

On OVH bare metal the tools' built-in cloud integrations (AWS, GCP, Azure) do not apply, so evidence comes from what the platform already produces. Link or import these rather than re-creating them:

| Control area | Evidence source |
| --- | --- |
| Change management | Git history and reviewed PRs in the `gitops` and infrastructure repos |
| Backup and recovery | CNPG backup status, Velero backup list, restore drill records in `docs/evidence/` |
| Encryption at rest and in transit | Talos disk encryption status, Cilium WireGuard status, TLS checks |
| Access control | Branch protection settings, OpenBao policies, authentik group membership reviews |
| Configuration baseline | Kyverno policy reports, OpenTofu plans with no drift |
| Vulnerability management | Trivy and Grype reports, Renovate PR history |
| Monitoring and incident response | Alertmanager routes, dead-man's-switch test, incident runbook |
| Vendor management | Signed BAAs (OVH, backup provider), subprocessor list |

Where a check can be automated, write it as a small script in the infrastructure repo that collects the output and pushes it to the platform's API on a schedule.

### Day-2 operations

- **Now:** complete the HIPAA risk analysis and the core policy set (access control, encryption, backup and recovery, incident response, workforce training, vendor and BAA management, sanctions). Record risk treatments in the register.
- **Monthly:** confirm automated evidence is arriving; attach restore-drill results; review open risks.
- **Quarterly:** access reviews; policy review; vendor and BAA review.
- **Yearly:** refresh the risk analysis; when a customer requires it, engage a CPA firm for SOC 2.
- Upgrade the platform on its release cadence; it is internet-adjacent software holding sensitive internal documents.

### Wazuh's role, corrected

Wazuh complements this tool but does not run agents on the Talos nodes: Talos has no package manager, and its immutable OS leaves nothing for host file-integrity monitoring to watch. Wazuh is fed by log forwarding (chapter 20), runs outside the production cluster in the security domain, and stays a stage-3 addition. Its alerts become evidence for the monitoring and incident-response controls above.

### Security and HIPAA notes

- The platform holds the company's security posture: policies, known risks, and vulnerability findings. Treat it as confidential and restrict access to the operator and, later, the auditor.
- Audit-ready features matter: role-based access, an immutable log of changes, and electronic sign-off for policies.
- Keeping PHI out is the operator's responsibility at upload time; the tool cannot enforce it.

### Failure modes

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Evidence gaps before an audit | Collection scripts stopped silently | Alert on missing evidence older than its expected interval |
| Policies drift from reality | Platform changed without updating policies | Tie policy review to the quarterly calendar; link policies to ADRs |
| Platform unavailable | Factory host down | Restore from backup; compliance work can pause, production is unaffected |

### Do not

- Upload screenshots, logs, or exports containing PHI as evidence.
- Host the compliance platform on the production cluster.
- Pay for an auditor before a customer requires a SOC 2 report; finish the HIPAA program first.

### Sources

Comp AI licensing and frameworks: [Help Net Security](https://www.helpnetsecurity.com/2026/04/07/comp-ai-open-source-compliance-platform/); pricing by quote: [soc2auditors.org](https://soc2auditors.org/software/comp-ai/). Probo license and APIs: [github.com/getprobo/probo](https://github.com/getprobo/probo). Openlane frameworks and roadmap: [theopenlane.io](https://www.theopenlane.io/product/frameworks/), [pkg.go.dev](https://pkg.go.dev/github.com/theopenlane/core). Checked October 2026.

## Appendices

### A. Version-pinning policy

- Every tool is pinned to an exact version (container images by digest, Helm charts by version, CLIs by version) in Git.
- Renovate proposes updates weekly; patch releases merge after the pipeline passes, minor releases after a staging soak, major releases after a written upgrade plan.
- Never skip a minor version for components that require stepwise upgrades (Kubernetes, Cilium, Talos, CloudNativePG).
- Record each production upgrade in the `gitops` commit message: component, from-version, to-version, and the release-notes items checked.

### B. Operational calendar

| Cadence | Task | Chapter |
| --- | --- | --- |
| Daily | Check backup success (CNPG, Velero, OpenBao snapshot); review critical alerts | 7, 11, 21 |
| Weekly | Review failed BullMQ jobs and outbox dead letters, Falco and Kyverno reports, vulnerability findings; merge Renovate PRs | 10, 16, 17, 18 |
| Monthly | PostgreSQL restore drill; alert review; exception expiry review | 7, 16, 19 |
| Quarterly | Velero and OpenBao restore drills; Valkey failover test; access reviews (authentik, OpenBao, Harbor); DR failover exercise (stage 2+) | 11, 12, 21 |
| Twice a year | Break-glass account test | 12, 15 |
| Yearly | Full rebuild from code; transit key rotation; BAA and provider review | 11, 22 |

### C. Glossary

| Term | Meaning |
| --- | --- |
| BAA | Business Associate Agreement: the HIPAA contract required with any vendor that handles PHI |
| CNI | Container Network Interface: the plugin that gives pods networking (Cilium) |
| CRD | Custom Resource Definition: extends Kubernetes with new object types used by operators |
| GitOps | Operating model where Git is the source of truth and an agent reconciles the cluster to it |
| PHI | Protected Health Information |
| PITR | Point-in-time recovery: restoring a database to any moment covered by backups and WAL |
| RLS | Row-level security: PostgreSQL policies that filter rows per tenant |
| RPO / RTO | Recovery point objective (data you can lose) / recovery time objective (time to restore service) |
| SBOM | Software bill of materials: inventory of components in an image |
| WAL | Write-ahead log: PostgreSQL's change log, used for replication and recovery |
| WORM | Write once, read many: storage that prevents modification or deletion for a retention period |
