# 01 — Assets, third parties and data flows

Part of the [risk analysis pack](./README.md) for CW-RA-01. **Draft: unreviewed, unsigned.**

Sources: `docs/architecture/CHARTWARDEN_SECURITY_HARDENING_v0_2.md` (data classes §8.1, key hierarchy §4.5, trust zones §7.1),
`docs/architecture/CHARTWARDEN_INTEGRATIONS_v0_1.md` (§2 inventory, §5 BAA register), `docs/architecture/CHARTWARDEN_DR_BCP_v0.1.md`
(§3.1 tiers, §4.8 single-host backup), `deploy/production/compose.yml`, `architecture/module-manifest.ts` (module ids, owned tables).
The complete module list and each module's tables are in the manifest; this file does not copy them.

**Data class** uses Hardening §8.1: PHI-Critical, PHI-Sensitive (42 CFR Part 2, mental health, HIV, abuse), Confidential,
Restricted, Internal. **CIA** marks which of confidentiality (C), integrity (I) and availability (A) the asset's loss would hurt most;
it is an engineering reading for the owner to confirm, not a score.

## 1. Information assets

| ID | Asset | Data class | Where it lives | Owning modules (manifest ids) | CIA | Controls and decisions |
|---|---|---|---|---|---|---|
| A-01 | Clinical record content: visit notes, care plans, assessments, HOPE, orders, eMAR, IDG, bereavement | PHI-Critical | PostgreSQL, tenant tables with RLS; selected fields sealed under the tenant key (ADR-0038) | 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16 | C I A | CW-AC-01, CW-AC-02, CW-AU-01, CW-AC-46, CW-AC-50..52; ADR-0010, ADR-0038 |
| A-02 | 42 CFR Part 2 (SUD) and family-violence content | PHI-Sensitive | Same stores; withheld per caller | 7, 8, 15, 22, 29, 39 | C | CW-AC-43, CW-AC-51, CW-AC-55; ADR-0014, ADR-0115 |
| A-03 | Patient identity and demographics; field-encrypted `ssn` and provider `tax_id` | PHI-Critical | PostgreSQL | 5, 40 | C I | CW-AC-01, CW-AC-06; ADR-0038 |
| A-04 | Documents and images (intake scans, signed forms, tenant BAAs, exports, rendered letters) | PHI-Critical (some Part 2) | Object store buckets `tenant-<orgId>`; **plaintext objects, host disk encryption only** | 22, 28, 34 | C I | CW-AC-05 (partial), CW-MAL-01, CW-DS-01; Hardening §4.2 |
| A-05 | Billing and claims data: 837I, 835, 270/271, authorizations, remittances, clearinghouse webhook payloads | PHI-Critical | PostgreSQL; webhook payloads AES-256-GCM sealed | 23, 24, 25, 41 | C I | CW-AC-05B, CW-AC-10, CW-AC-24, CW-PI-01..06, CW-TX-02; ADR-0053, ADR-0100 |
| A-06 | Messaging and alert content; attachments; escalations | PHI-Critical | PostgreSQL, object store | 19, 36 | C A | CW-AC-37, CW-CS-01; ADR-0074 |
| A-07 | Audit trail (`audit_event`, support-session ledger) | Confidential (carries actor and resource ids) | PostgreSQL, partitioned, app role INSERT and SELECT only | 4, 34 | I | CW-AU-01, CW-AC-40; Hardening §13.1 |
| A-08 | Tenant-held credentials and vendor secrets: clearinghouse credential (CW-AC-17, key derived from the M24 key), DoseSpot clinic key (CW-AC-21, sealed under the tenant key-ring DEK) | Confidential | PostgreSQL, sealed per tenant | 12, 23, 24, 34 | C | CW-AC-17, CW-AC-21; ADR-0111 |
| A-09 | Authentication material: password hashes, session tokens, passkeys | Confidential | PostgreSQL (Better Auth). Hardening §5.1.4 and DR/BCP §3.1 also describe a Valkey session cache; this pack found no such wiring in `packages/auth`, so treat it as documented, code unverified | 2 | C I | CW-IA-01, CW-AC-04, CW-AC-45 |
| A-10 | Key material. Four env-held application keys (ADR-0045 Decision 1): `M34_TENANT_KEK` (wraps the per-tenant DEK rings), `M24_CREDENTIAL_ENCRYPTION_KEY`, `MESSAGING_ENCRYPTION_KEY` and `TWO_FACTOR_ENCRYPTION_KEY` (one user-level key for TOTP secrets, ADR-0034). Also the per-tenant DEK rings, backup repository keys, off-site SSE-C key, Ed25519 actor signing key, webhook HMAC keys | Confidential | `.env.production`, Docker secrets under `secrets/`, `tenant_key_ring` | 2, 34, platform | C | ADR-0045, ADR-0038, ADR-0034, CW-AC-07; Hardening §4.5 |
| A-11 | Backups: pgBackRest repositories (local and off-site), per-snapshot object mirror | PHI-Critical | Local volume, off-site S3-compatible Object Lock bucket | platform | C A | CW-CP-01; DR/BCP §4.8. That the sidecar and WAL archiving run in production is an owner statement with no repository evidence (CW-CP-01) |
| A-12 | Retired MinIO volume `<prefix>_minio-data` on a host that went through the SeaweedFS cutover and has not removed it | PHI-Critical | Host volume, outside backups and outside compose | platform | C | CW-AC-05, CW-DS-01 |
| A-13 | AI inputs and outputs: DocLens extraction, prompts, drafts | PHI-Critical (cloud path disabled until the BAA flag is set) | Worker memory, PostgreSQL | 22, 32 | C I | CW-AI-01; ADR-0012 |
| A-14 | Logs and telemetry: application logs, nginx logs, object-store access stream | Restricted, PHI-adjacent | Host, container stdout, Fluent Bit | platform | C | CW-AC-37; `deploy/production/README.md` ("Nginx logging (PHI)") |
| A-15 | Source, CI configuration, release images, SBOM | Internal | GitHub, GHCR | repository | I | CW-CM-01, CW-VM-01, CW-SEC-01 |
| A-16 | Platform tenant register: onboarding data, BAA records, go-live attestations, pricing | Confidential | PostgreSQL | 34, 35 | I | CW-AC-12..15, CW-AC-18, CW-AC-22 |

## 2. System assets (what the repository deploys)

From `deploy/production/compose.yml`. Every application service binds loopback; host Nginx is the sole public ingress and owns TLS.

| ID | Component | Role | Holds or touches | Notes |
|---|---|---|---|---|
| A-20 | Host Nginx (public edge) | TLS, routing, request limits, PHI-safe access-log format | All inbound traffic | TLS configuration not asserted by a gate (CW-TX-01). ADR-0049 says production runs host nginx without Pangolin; Pangolin is the target edge (Architecture §19), so it is not an asset of the shipped stack |
| A-21 | `web` | Static SPAs: staff app, portal, Platform Ops (separate document root) | No PHI at rest | `web-security-headers.conf` (CW-TX-01) |
| A-22 | `api` (Bun backend) | All business routes, authentication, RBAC and ABAC, outbox | A-01..A-10 in memory; holds three database logins in its environment: the application login (`chartwarden_app`, NOBYPASSRLS), a platform login (`DATABASE_PLATFORM_URL`, `LOGIN BYPASSRLS` per `scripts/db/provision-runtime-roles.ts`) and a destruction login (`DATABASE_DESTRUCTION_URL`), plus the env-held keys (A-10) | Loopback `:3000`. The platform login serves cross-tenant admin reads and writes, the platform-context enumerators and the org-offboarding eraser; the destruction login is org-scoped by design (V-37) |
| A-23 | `worker` | Queues, relay, retention and destruction jobs, outbound vendor calls | As `api`, including the platform and destruction logins | |
| A-24 | `postgres` (project image, digest-pinned) | System of record; RLS FORCEd; `chartwarden_app` NOBYPASSRLS | A-01..A-09, A-16 | CW-AC-01 |
| A-25 | `valkey` | BullMQ queues and ephemeral state, AOF persistence on a volume. Per code comments, production binds the RBAC permission cache (`packages/auth/src/rbac/cache.ts`), the credential-throttle limiter keys and the auditor one-time link tokens (`packages/auth/src/identity/`) to it | Whether job payloads carry PHI was not verified | Started as `valkey-server --appendonly yes`: no `requirepass`, no TLS in the compose file (Hardening §4.3 shows both as the design). The runtime bindings were not inspected |
| A-26 | `seaweedfs` | S3-compatible object store | A-04, attachments | App key scoped to `tenant-*` and `chartwarden-*` by `app-policy.json`, including object delete and version delete (CW-AC-01); `127.0.0.1:9000` behind the storage vhost |
| A-27 | `clamav` | Upload and attachment scanning, own `scan` network | Upload bytes in transit | CW-MAL-01 |
| A-28 | `docling-worker` | DocLens OCR and layout; no object-store credentials, presigned URL only | Document pages | CW-AI-01 |
| A-29 | `fluent-bit` | Forwards object-store access records to the api webhook | Access metadata | Best-effort stream; an audit gap is accepted for it (compose comment, GAP-141) |
| A-30 | `hl7-listener` (profile `hl7-listener`) | M29 MLLP listener | HL7 ADT, ORU, ORM | Binds `127.0.0.1` unless `M29_MLLP_BIND_ADDRESS` is set; its environment also carries the platform and destruction logins (compose lines 490-491) |
| A-31 | `rust` (profile `rust`) | Rust API behind the Bun bridge | Reads through RLS as `chartwarden_app` | **Merged off** (`RUST_ROUTES` empty) (CW-AC-07) |
| A-32 | One-shot privileged jobs: `migrate`, `provision`, `object-store-provision`, `tenant-buckets` | Schema, role and bucket provisioning; some run with the database admin URL | Admin credentials | Hold-contract refusal in `migrate.ts` (CW-CM-01) |
| A-33 | Backup sidecar (`compose.backup.yml`) | pgBackRest and `mc mirror` to the off-site target | A-11, backup keys | CW-CP-01; the second-copy overlay `compose.object-copy.yml` is **not enabled in production** |
| A-34 | `.env.production` | One secrets file that reaches seven containers | A-10, A-08 material | Rust service deliberately takes no `env_file` |
| A-35 | CI/CD: GitHub Actions, GHCR, deploy over SSH with a restricted deploy account | Builds, signs, pushes, deploys | A-15, deploy key | CW-CM-01. `deploy.sh` cosign-verifies the backend, web, docling and Rust images, with an opt-out (`CHARTWARDEN_DEPLOY_ALLOW_UNVERIFIED=1`, which does not apply to Rust); the postgres, clamav and backup images are digest-pinned and not verified by `deploy.sh`. Full CI is waived on the deploy path (V-15) |
| A-36 | Developer workstations and AI coding agents | Write code and run gates | Source only, by policy | CW-CM-02 |
| A-37 | Client devices: browsers and the separate React Native app (ADR-0072, which supersedes the Capacitor wrap of ADR-0035; the mobile app is not built from this repository) | Display PHI to users | PHI in memory, device storage | CW-AC-04; ADR-0074 for lock-screen text |

## 3. People and process assets

| ID | Asset | Notes |
|---|---|---|
| A-40 | ChartWarden platform operators (`platform_ops`, `superadmin`) | One role holds data entry, BAA upload, register write, go-live approval and pricing (CW-AC-22). No `superadmin` holder exists in production (CW-AC-45, ADR-0112) |
| A-41 | Tenant staff by role; org-wide scope for `administrator` and `org_admin` | ADR-0090 widened reads and writes by decision |
| A-42 | Patients, family members and proxies on the portal | M31; CW-AC-09 |
| A-43 | External auditors | Two-stage session behind BAA acceptance and a second factor (CW-AU-02) |
| A-44 | Security governance roles (Security Owner, Compliance Officer, Vulnerability Manager, Incident Responder) | Hardening §2.1 names the **same interim owner for all four**; AI Governance §3.2 records "Single-Person Owner Risk". Roles only; no person is named in this pack |

## 4. Third parties

The register's own vendor list (CW-BA-01) names OVH, Hostinger, Postmark, DoseSpot, Stedi, Claim.MD, Anthropic and GitHub.
The integration catalog (§2) is the master list and carries a wiring-status banner: many catalogued surfaces are **not built**.
This pack lists classes and does not claim any is wired. A vendor is relevant here only where PHI can reach it.

| ID | Class | PHI | BAA status as recorded | Controls |
|---|---|---|---|---|
| P-01 | Hosting providers (VPS, off-site object target, DNS and edge) | Yes (hosts everything) | Prose only (CW-BA-01); the off-site S3-compatible vendor is unnamed and the repository cannot verify it discards the SSE-C key (Hardening §4.2) | CW-BA-01, CW-AC-05 |
| P-02 | Clearinghouses (Stedi, Claim.MD) | Yes | Tenant-held and platform-verified per tenant (CW-AC-17); platform account's Claim.MD BAA recorded as received (CW-BA-01) | CW-AC-17, CW-AC-24, CW-TX-02, ADR-0053 |
| P-03 | DoseSpot (and Surescripts through it) | Yes | Integrations §5: "TBD — confirm executed before Module 12 prod" | CW-AC-21, CW-AC-23, ADR-0111 |
| P-04 | Anthropic (cloud AI) | Yes, with ZDR and redaction | "in progress" (CW-BA-01); cloud path stays disabled until `external.anthropic_baa_executed` (ADR-0012) | CW-AI-01 |
| P-05 | Messaging providers (Postmark, Twilio, Web Push) | No, by rule | Integrations §5: TBD | CW-AC-37; ADR-0074 |
| P-06 | CMS channels (MAC, HETS, iQIES, Medicaid) | Yes | Trading-partner agreements, not BAAs | CW-PI-03; Integrations §5 |
| P-07 | Telehealth (Daily.co), EVV aggregators, DME, pharmacy, print and mail, fax, triage vendor, lab and ADT feeds | Yes | Integrations §5 reads "Required — EXECUTED before prod" for EVV, DME, pharmacy, print and mail, fax and the triage vendor (which also needs a QSOA for Part 2), and "TBD" for Daily.co and the per-feed ADT and lab agreements | Integrations §5; ADR-0014, ADR-0020 |
| P-08 | GitHub (source, Actions, GHCR) | Source only, by policy | Named in CW-BA-01 | CW-CM-01, CW-SEC-01 |

## 5. Trust boundaries

| ID | Boundary | What crosses | Source |
|---|---|---|---|
| B-1 | Internet to host Nginx | All client traffic | CW-TX-01; `deploy/production/web-security-headers.conf` |
| B-2 | Host Nginx to `api` and `web` on loopback | Authenticated requests; the `x-cw-actor-assertion` header is blanked | `deploy/production/nginx/`, `header-hygiene.ts` (CW-AC-07) |
| B-3 | `api`/`worker` to `postgres` | SQL as `chartwarden_app` with the `app.org_id` setting on the request path; `api`, `worker` and `hl7-listener` also hold the BYPASSRLS platform login and the destruction login in their environment (V-37); the admin URL only in one-shot jobs | CW-AC-01; ADR-0010 |
| B-4 | `api` to `rust` | Ed25519-signed actor assertion over a Unix socket; `rust-db` network is internal and holds only postgres | CW-AC-07; Hardening §3.7 |
| B-5 | `api`/`worker` to vendors | Outbound HTTPS, X12, REST | Integrations §2 |
| B-6 | Platform-operator plane to tenant data | Support session bound to a consent grant; no standing access | CW-AC-40, CW-AC-45; ADR-0112 |
| B-7 | Build and release plane to production | Images (signature check for four of them, see A-35); SSH deploy; migrations. `release` needs only `debounce` and `quality` while full CI is waived | CW-CM-01 |
| B-8 | Production to backup plane | Encrypted repository and mirrored objects | CW-CP-01 |
| B-9 | Client device to user | PHI rendered on screen, push text | ADR-0074 |

The Hardening guide's VLAN zones (§7.1: Public, DMZ, App, Data, Admin, Mgmt) are **target**; the stack's actual separation is
the Compose networks (`default`, `audit`, `scan`, `rust-db`) plus loopback binding.

## 6. Data flows

| ID | Flow | Data | Protection recorded | Controls |
|---|---|---|---|---|
| F-01 | Browser or app to edge to `web`/`api` | A-01..A-06 | TLS at host Nginx; HSTS; host-only `__Host-` cookies per tenant host; the host is never authority (403 `TENANT_HOST_MISMATCH`) | CW-TX-01, CW-IA-01; ADR-0049 |
| F-02 | `api`/`worker` to `postgres` | A-01..A-09 | NOBYPASSRLS role, FORCEd RLS, `app.org_id` setting | CW-AC-01; ADR-0010, ADR-0011 |
| F-03 | `api`/`worker` to `valkey` | Queue payloads, permission cache, limiter keys, one-time link tokens | Compose network only; no password or TLS in the compose file (V-19) | Hardening §4.2, §4.3 (target) |
| F-04 | `api` to `seaweedfs`; browser to the storage vhost by presigned URL | A-04 | S3 over plain HTTP on the Compose network (target: TLS 1.3); TLS ends at the host storage vhost; key scoped to `tenant-*` and `chartwarden-*`; time-limited URLs | CW-AC-01, CW-TX-01; Hardening §4.3 |
| F-05 | Upload to `clamav` before store | Upload bytes | Dedicated `scan` network | CW-MAL-01 |
| F-06 | `worker` to `docling-worker`; `worker` to cloud AI | Document pages; prompts | Bearer token; presigned URL; no object-store credentials in the worker; cloud path gated on BAA and ZDR flags | CW-AI-01; ADR-0012 |
| F-07 | `api`/`worker` to clearinghouse; clearinghouse webhook to `api` | A-05 | Credential sealed per tenant; HMAC-SHA256 verified before storage; payload sealed; ingress off unless enabled | CW-AC-17, CW-AC-24, CW-TX-02; ADR-0053 |
| F-08 | `worker` to DoseSpot and back | Orders, prescriber data | Clinic key sealed per tenant; unknown outcome is held for a person; EPCS deferred | CW-AC-21, CW-AC-23; ADR-0111, ADR-0019 |
| F-09 | Hospital and lab feeds to `hl7-listener` | HL7 ADT, ORU | Loopback default; certificate pin and destination policy; Part 2 redaction before persist | CW-TX-01; Hardening §3.5 |
| F-10 | `api` to `rust` | Actor assertion, read queries | Signed assertion, single-use `jti`, internal network | CW-AC-07 (merged off) |
| F-11 | `seaweedfs` access log to `fluent-bit` to `api` webhook | Access metadata, no object bytes | `audit` network is internal; bearer on the webhook | Compose comment, GAP-141 |
| F-12 | `postgres` and `seaweedfs` to backup sidecar to off-site target | A-11 | pgBackRest AES-256 repository encryption; SSE-C for objects; Object Lock COMPLIANCE (the design in DR/BCP §4.8; that it runs in production is an owner statement, CW-CP-01) | CW-CP-01; DR/BCP §4.8 |
| F-13 | CI to GHCR to host | A-15 | Digest-pinned images; cosign check for the backend, web, docling and Rust images (opt-out exists, A-35); forward-only migrations with contract hold | CW-CM-01 |
| F-14 | Platform operator to platform hostname to `api` | A-16, support-session reads | Separate document root; step-up; consent grant; per-address request and connection limits on the BAA-upload route only | CW-AC-22, CW-AC-40, CW-AC-45 |
| F-15 | `api` to internal callers using the shared system credential | Any tenant named by `x-internal-org-id` | `INTERNAL_SERVICE_TOKEN`, constant-time compare, no rotation, no per-request binding | V-05; Hardening §6.5 |
| F-16 | Developer or agent to repository | Source | PreToolUse guard, secret and PHI scans | CW-CM-02, CW-SEC-01 |
