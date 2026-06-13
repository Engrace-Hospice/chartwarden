# WardenX — Security Hardening Guide

**Document ID:** WARDENX_SECURITY_HARDENING
**Status:** v0.2
**Owner:** Fabrice V. Adjam (Engineering + interim Security/Compliance; specialized roles contracted as team grows)
**Companion to:** WARDENX_ARCHITECTURE v0.11, WARDENX_SYSTEM_DESIGN v0.3, WARDENX_DR_BCP v0.1, WARDENX_OPS_RUNBOOK v0.1
**Review cadence:** Annual full review; quarterly partial review of threat model and vulnerability management sections
**Last reviewed:** 2026-06-08

**Document Control — Changes from v0.1:** Session idle timeout reconciled to **15 minutes for all clinical sessions** (was inconsistently stated as "30 min web / 15 mobile" in §5.1.4 and "8-hour idle" in §3.2.3 / §10). Absolute timeout remains 8-hour work-session / 24-hour maximum; UI screen-lock is a separate 5-minute soft re-auth. Driver: Module 2 lock decision D1 — architecture §7's stricter 15-min governs for shared clinical workstations; all timeouts derive from one `SESSION_POLICY` constant.

**Scope distinction:** Operations procedures live in WARDENX_OPS_RUNBOOK; AI-specific governance lives in WARDENX_AI_GOVERNANCE; vendor security reviews live in WARDENX_INTEGRATIONS. This document is the threat-and-control layer cutting across all of them.

-----

## 1. Purpose & Scope

### 1.1 Purpose

This document establishes WardenX’s security posture: how we model threats, what controls we implement, how we validate they work, and how we respond when they fail. It is the principal reference for:

- HIPAA Security Rule compliance evidence (§164.306-§164.318)
- Customer security questionnaires and procurement reviews
- Engineering decisions where security implications are non-obvious
- Incident response when an event has security implications
- Future audit readiness (SOC 2 Type II, HITRUST CSF when sought)

### 1.2 What This Document Is

- A threat model: what we are defending against
- A control catalog: how we defend
- A standards reference: cryptographic, code, network, infrastructure standards
- A validation plan: how we prove controls work (testing, scanning, audits)
- A response plan: what to do when controls fail

### 1.3 What This Document Is Not

- A general security textbook — assumes baseline security literacy
- A vendor procurement guide — see WARDENX_INTEGRATIONS for vendor security reviews
- An incident response playbook for specific scenarios — see WARDENX_DR_BCP §10 for those
- An operational runbook for routine security work (key rotation procedures, etc.) — see WARDENX_OPS_RUNBOOK §8

### 1.4 Security Principles

Five principles drive every decision in this document:

1. **Defense in depth.** No single control is trusted to be sufficient. RLS plus application authorization plus audit plus monitoring — each layer assumes the others might fail.
1. **Least privilege.** Every identity (human, service, role) gets exactly the access it needs and nothing more.
1. **Privacy by design.** PHI handling defaults to most-restrictive; data minimization in collection, retention, and disclosure.
1. **Fail closed.** When a security check fails, deny access. Never default to allow on error.
1. **Auditable and verifiable.** Every privileged action is logged, every control is testable, every claim is provable.

-----

## 2. Security Governance

### 2.1 Roles

|Role                     |Responsibilities                                               |Current Owner                                           |Future State                            |
|-------------------------|---------------------------------------------------------------|--------------------------------------------------------|----------------------------------------|
|**Security Owner**       |Threat model, control design, security architecture decisions  |Fabrice                                                 |Dedicated Security Engineer post Phase 2|
|**Compliance Officer**   |HIPAA compliance, breach assessments, regulatory communications|Fabrice (interim) → contracted compliance counsel       |Internal Compliance Officer post Phase 3|
|**Vulnerability Manager**|Tracking CVEs, patches, scan findings, remediation             |Fabrice                                                 |Security Engineer                       |
|**Incident Responder**   |Active incident response; forensics                            |Fabrice + on-call → contracted IR firm for high-severity|Specialized IR team or retained firm    |
|**Penetration Tester**   |Third-party adversarial testing                                |None yet (Phase 2 requirement)                          |Annual external pen test                |
|**Bug Bounty Triage**    |(Future)                                                       |None                                                    |Phase 3+ when public bounty program live|

### 2.2 Decision Authority

|Decision                                      |Decided by                                |Reviewed by                     |
|----------------------------------------------|------------------------------------------|--------------------------------|
|Threat model changes                          |Security Owner                            |Engineering + Compliance        |
|Cryptographic standard changes                |Security Owner                            |Engineering                     |
|New external integration with PHI exposure    |Security Owner + Compliance               |Customer (signed BAA)           |
|Vulnerability remediation timeline waiver     |Security Owner                            |Engineering Director            |
|Break-glass credential usage                  |Security Owner + Compliance after the fact|Compliance audit                |
|Security incident classification              |Incident Commander                        |Compliance for breach assessment|
|Penetration test findings remediation priority|Security Owner                            |Engineering                     |

### 2.3 Security Documentation Hierarchy

```
Architecture/SystemDesign documents      ← What WardenX is
  ↓
This document (Security Hardening)       ← What threats matter and how we defend
  ↓
Module specs (per-module §6 Permissions) ← How threats manifest in this module
  ↓
Code & infrastructure                    ← What we built
  ↓
Tests + Audits                            ← Proof it works
```

-----

## 3. Threat Model

### 3.1 Threat Modeling Methodology

WardenX uses **STRIDE** as the primary threat modeling framework, applied at two levels:

- **Platform-level STRIDE** (§3.2) — threats that cut across the whole system
- **Module-level STRIDE** (§3.4) — per-module top threats documented in each module spec; this document holds a summary for the highest-risk modules

STRIDE categories:

|Category                  |What it means                          |Primary defense                                      |
|--------------------------|---------------------------------------|-----------------------------------------------------|
|**S**poofing              |Pretending to be someone/something else|Authentication, identity proofing                    |
|**T**ampering             |Modifying data without authorization   |Integrity controls, immutable audit, signatures      |
|**R**epudiation           |Denying actions taken                  |Non-repudiation via audit, signed events             |
|**I**nformation disclosure|Unauthorized PHI access                |Encryption, authorization, RLS, network segmentation |
|**D**enial of service     |Making system unavailable              |Rate limiting, capacity planning, DDoS mitigation    |
|**E**levation of privilege|Gaining unauthorized authority         |Authorization checks, RBAC/ABAC, RLS as defense layer|

### 3.2 Platform-Level Threats

#### 3.2.1 Threat: Cross-Tenant Data Access (I — Information Disclosure)

**Description:** A user or process associated with Tenant A gains access to Tenant B’s PHI.

**Attack vectors:**

- Application bug forgets to filter by `organization_id` in a query
- Session token leaked and reused with manipulated org context
- Privileged staff account compromised and used to traverse tenants
- ML/AI features that pool data across tenants accidentally expose cross-tenant

**Controls (defense in depth):**

- **Layer 1: Database RLS** (Module 1 §3.11) — every PHI table has policies enforcing `organization_id = current_setting('app.org_id')`. Application bugs cannot bypass this.
- **Layer 2: Application authorization** (Module 3 RBAC + ABAC) — service layer checks organization context before queries
- **Layer 3: Session binding** (Better Auth) — session tied to specific `active_organization_id`; cannot manipulate via client
- **Layer 4: PgBouncer + app role** — `wardenx_app` role’s RLS policies prevent leakage even if application is buggy
- **Layer 5: Audit** — every PHI access logged with org context; RLS denials logged as `security.rls_denied` (volume should be ~zero in production)
- **Layer 6: Monitoring** — Prometheus metric `rls_denials_total` alerts at any nonzero rate

**Validation:**

- Automated RLS isolation test suite required in every module spec (Module 1 §9.3, Architecture §25.11)
- Manual code review specifically for `organization_id` handling on every PHI-touching PR
- Penetration test annually attempting cross-tenant access (Phase 2)

#### 3.2.2 Threat: Audit Log Tampering (T — Tampering / R — Repudiation)

**Description:** An attacker (insider or compromised account) modifies or deletes audit log entries to cover unauthorized access.

**Attack vectors:**

- SQL injection if input validation fails on an admin interface
- Direct database access via compromised admin credential
- Application code path that grants UPDATE/DELETE to audit_event

**Controls:**

- **Layer 1: GRANT restrictions** — `wardenx_app` role has only `INSERT, SELECT` on `audit_event`; UPDATE and DELETE not granted at all. Application code physically cannot modify audit, regardless of bugs.
- **Layer 2: Append-only schema** — `audit_event` partitioning is by `created_at`; no application path to modify historical rows
- **Layer 3: Audit of audit** — admin or platform role access to audit table itself logs a meta-event (`audit.elevated_access`)
- **Layer 4: Off-system backup** — pgBackRest backups encrypted, retained 7+ years; audit can be cross-referenced against backups even if live DB is modified
- **Layer 5: Cryptographic seal** (future enhancement) — hash chain over audit events such that any modification breaks the chain; not in Phase 1 due to operational complexity but planned

**Validation:**

- Test: `wardenx_app` attempting UPDATE/DELETE on `audit_event` must fail with permission error (Module 1 §9.3)
- Quarterly: random sample of 100 audit events compared to backup to detect tampering
- Monthly: review of all `audit.elevated_access` events

#### 3.2.3 Threat: Account Takeover (S — Spoofing)

**Description:** Attacker gains control of a legitimate user account and uses it to access PHI.

**Attack vectors:**

- Phishing — user clicks link, enters credentials on lookalike site
- Credential stuffing — reused password from breach elsewhere
- Session hijacking — token theft via XSS, network interception, malware
- Social engineering — user tricked into revealing 2FA code

**Controls:**

- **Strong passwords** — minimum 12 characters, complexity rules, breach-password check (HaveIBeenPwned API or k-anonymity equivalent)
- **2FA required for clinical roles** — TOTP, SMS fallback for accessibility but TOTP preferred; passkey (WebAuthn) supported and preferred for highest assurance
- **Session controls** — HttpOnly Secure SameSite=Strict cookies; **15-minute idle**, 8-hour work-session, 24-hour absolute; UI screen-lock (5-min soft re-auth); binding to IP+user-agent prefix (with grace for mobile carrier IP changes); biometric re-auth on mobile
- **Suspicious activity detection** — login from new geography, new device, off-hours pattern triggers re-auth and alert
- **Rate limiting** — 5 failed logins per username per 10 min → temporary lockout; 30 failed logins per IP per 10 min → temporary block
- **Phishing-resistant auth for high-privilege** — passkeys required for `platform_ops` and `org_admin` roles
- **Account recovery hardening** — recovery requires multiple-factor verification including out-of-band; never restorable solely via email link

**Validation:**

- Penetration test includes phishing simulation (Phase 2)
- Quarterly review of failed login patterns
- Monthly review of new-device/new-geography logins for anomaly

#### 3.2.4 Threat: Privilege Escalation (E)

**Description:** A user with limited access gains elevated access they should not have.

**Attack vectors:**

- Bug in authorization check (forgot a role check)
- IDOR (Insecure Direct Object Reference) — accessing resource via URL manipulation
- Role assignment vulnerability — user can modify their own membership.role
- ABAC predicate manipulation — context modified to satisfy predicate falsely

**Controls:**

- **Server-side authorization always** — never trust client-side role assertions
- **Module 3 RBAC + ABAC** with predicate evaluation server-side; predicates use server-controlled context (oncall_shift_active, caseload_membership, etc.)
- **Role assignment audit** — every membership change emits `membership.role_changed` audit event
- **Role self-modification prohibition** — users cannot modify their own membership roles; org_admin required
- **Tested authorization** — every module spec must include authorization test cases for: each role gets expected access, each role denied unexpected access, edge cases (boundary conditions, expired memberships)
- **RLS as backstop** — even if authorization fails, RLS prevents cross-tenant escalation

**Validation:**

- Code review: every new API endpoint reviewed for explicit authorization check
- Static analysis: Lint rule for missing authorization decorators (custom Biome rule)
- Test: integration tests cover authorization for every role × action combination
- Penetration test: explicit privilege escalation attempts

#### 3.2.5 Threat: PHI Disclosure via External Services (I)

**Description:** PHI is exposed to or through external services in ways that violate BAA terms or HIPAA.

**Attack vectors:**

- Logging PHI to Sentry without redaction → Sentry support staff can see
- Sending PHI to Anthropic when not necessary
- PHI in URLs that get logged by CDN, WAF, or proxy
- PHI in error messages returned to client → cached in browser history
- Telemetry exporting span attributes that contain PHI

**Controls:**

- **Pino redact list** (Module 1 §8.5) — explicit list of PHI fields scrubbed before logging
- **Sentry `beforeSend`** — runtime PHI scrub of all error context before transmission
- **OpenTelemetry span attribute filter** — span attributes never contain PHI (only IDs, codes, hashed identifiers)
- **PHI in URLs prohibited** — design rule; URLs carry resource IDs (UUIDs are not PHI) but never names, MRNs, DOBs, etc.
- **Error messages sanitized** — generic to client; detail in logs (which are scrubbed)
- **Anthropic PHI minimization** — see WARDENX_AI_GOVERNANCE for full handling rules; principle: send minimum necessary, never raw chart, prefer structured summaries over raw text
- **Zero Data Retention with Anthropic** — when contractually available, enabled to ensure no PHI persisted on Anthropic side
- **BAA inventory** — every vendor with PHI exposure has a current BAA; tracked in WARDENX_INTEGRATIONS

**Validation:**

- Unit tests for Pino redact (test with PHI-bearing payloads, verify redaction)
- Quarterly review of Sentry events sampled for accidental PHI
- Quarterly review of Anthropic API logs for PHI minimization compliance
- BAA tracking in vendor management review

#### 3.2.6 Threat: Insider Threat (E + I + T)

**Description:** A WardenX employee/contractor or customer’s staff member uses legitimate access to harm patients or steal data.

**Attack vectors:**

- WardenX engineer abuses platform_ops role
- Customer staff member exports records inappropriately
- Disgruntled departing employee exfiltrates data before departure
- Family member or caregiver granted portal access uses it inappropriately

**Controls:**

- **Least privilege** — even platform_ops role tightly scoped; break-glass requires extra step
- **Separation of duties** — backup keys and encryption keys held separately; no single individual can unilaterally access all data
- **All admin actions audited** with mandatory retention class `compliance` (6+ years)
- **Quarterly access review** (WARDENX_OPS_RUNBOOK §12.2) — verifies access still appropriate
- **Departing employee process** — access revocation within 1 hour of termination; sealed envelopes inventoried and reseaied if access ever held
- **Anomaly detection** — bulk exports, off-hours access, unusual access patterns trigger alerts (see §15.3)
- **Background checks** — required for WardenX engineering hires (per HIPAA workforce security §164.308(a)(3))
- **Workforce sanctions policy** — documented per §164.308(a)(1)(ii)(C); sanctions for security violations defined in policy

**Validation:**

- Monthly: anomaly detection review
- Quarterly: access review
- Annually: full risk analysis includes insider threat scenarios
- Termination process tested via tabletop exercise annually

#### 3.2.7 Threat: Supply Chain Compromise (T + I)

**Description:** A dependency, vendor, or build tool is compromised and used to inject malicious code into WardenX.

**Attack vectors:**

- npm package compromised with malicious update
- Container base image compromised
- Build infrastructure (GitHub Actions runner) compromised
- Vendor (Anthropic, DoseSpot, etc.) compromised with downstream impact

**Controls:**

- **Pinned dependencies** — explicit versions in `package.json`; renovate proposes updates via PR (reviewed)
- **SBOM generation** in CI (CycloneDX format); SBOM attached to image manifest
- **Image signing** with cosign; verification on deploy
- **Dependency scanning** (npm audit, Snyk, or similar) in CI — blocks merge on Critical CVEs
- **Container scanning** (Trivy, Grype, or similar) — scans base images and built images for known CVEs
- **Vendor BAA + security review** — every vendor with PHI access goes through security review documented in WARDENX_INTEGRATIONS
- **Network segmentation** — vendor compromise has limited blast radius (e.g., compromised DoseSpot cannot reach WardenX database)

**Validation:**

- Every CI run produces SBOM and scan results
- Monthly: review of dependency scan findings, remediation
- Quarterly: vendor security review for any updates to vendor security posture
- Annually: tabletop exercise of supply chain compromise scenario

#### 3.2.8 Threat: Denial of Service (D)

**Description:** WardenX becomes unavailable, impacting patient care.

**Attack vectors:**

- Application-layer DoS — slow requests, expensive queries
- Network DDoS — flooding edge
- Resource exhaustion — DB connections, disk, memory
- Compromised tenant or user causing accidental DoS (e.g., misconfigured automation)

**Controls:**

- **Edge DDoS protection** — Cloudflare or equivalent (initial Phase 1: Pangolin with rate limiting; Phase 2: full CDN with DDoS protection)
- **Rate limiting** per route and per user (System Design §6.6)
- **Query timeouts** — server-enforced max query duration
- **Resource quotas per tenant** — bulk export limits, request rate limits, AI token budgets
- **Capacity planning** — see WARDENX_OPS_RUNBOOK §10
- **Graceful degradation** — non-critical features (AI, reporting) shed under load before clinical features

**Validation:**

- Load testing against production-equivalent infrastructure (Phase 2)
- Quarterly: rate-limit and quota effectiveness review
- Synthetic monitoring detects degradation

#### 3.2.9 Threat: AI-Specific Threats (I + T + Repudiation)

**Description:** AI features introduce novel attack surfaces — prompt injection, data exfiltration via model, hallucination causing harm, model manipulation.

This is the domain of WARDENX_AI_GOVERNANCE; cross-referenced here as part of the threat model.

**Key controls referenced:**

- Layer 1 deterministic narrative always available (HearthNote architecture)
- LLM never trusted with factual changes (Layer 2 hard-blocked on med/vital/code changes)
- Prompt injection detection and rejection
- PHI minimization in prompts
- Output validation against authoritative sources
- Human-in-loop for safety-critical AI outputs

### 3.3 Threat Model Maintenance

- Reviewed quarterly
- Updated when: new module added with novel attack surface, new vendor with PHI access added, post-incident if attack vector not previously modeled, regulatory change

### 3.4 Per-Module Highest-Risk Threats Summary

Full STRIDE in module specs; summary here:

|Module                  |Top threats                                                                 |
|------------------------|----------------------------------------------------------------------------|
|1 Foundation            |RLS bypass (I+E), audit tampering (T+R)                                     |
|2 Identity & Org        |Account takeover (S), session hijacking (S), credential stuffing (S)        |
|3 Authorization         |Privilege escalation (E), role assignment bypass (E)                        |
|4 Audit                 |Log tampering (T), log suppression (T+R)                                    |
|5 Patient & Demographics|Cross-tenant PHI access (I), IDOR (E)                                       |
|8 Encounters            |Tampering with clinical record (T+R), unauthorized signing (S)              |
|12 DoseSpot             |Prescribing fraud (T), DEA EPCS bypass (S+T)                                |
|22 Documents            |Unauthorized export (I), document tampering (T)                             |
|23 Billing              |Billing fraud (T+R) — fake claims, false visits                             |
|29 External Interfaces  |Spoofed inbound data (S+T) — fake ADT messages, fake lab results            |
|31 Portal               |Patient impersonation (S), unauthorized family access (S+I)                 |
|32 AI Platform          |Prompt injection (T), PHI exfiltration via model (I), hallucination harm (T)|
|34 SaaS Platform        |Tenant escape (I+E), provisioning abuse (E)                                 |
|39 Consent              |Consent bypass (E+R), forgery (S+T)                                         |
|40 MDM                  |Cross-tenant overlay leak (I), canonical record poisoning (T)               |

-----

## 4. Cryptographic Standards

### 4.1 Approved Algorithms (per NIST SP 800-131A current revision)

|Use                     |Approved                                                                         |Key length minimum                      |
|------------------------|---------------------------------------------------------------------------------|----------------------------------------|
|Symmetric encryption    |AES-GCM, AES-CBC (with HMAC)                                                     |256-bit                                 |
|Asymmetric encryption   |RSA-OAEP, ECDH                                                                   |RSA 3072, ECDH P-256                    |
|Digital signatures      |RSA-PSS, ECDSA, EdDSA (Ed25519)                                                  |RSA 3072, ECDSA P-256, Ed25519 native   |
|Password hashing        |Argon2id (preferred), bcrypt                                                     |Argon2id m=64MB t=3 p=4 / bcrypt cost 12|
|HMAC                    |HMAC-SHA-256 or HMAC-SHA-512                                                     |n/a                                     |
|Random number generation|OS CSPRNG (`/dev/urandom`, `crypto.randomBytes`)                                 |n/a                                     |
|TLS                     |TLS 1.3 (preferred); TLS 1.2 with strict cipher suites only when interop required|n/a                                     |

**Explicitly prohibited:**

- MD5 for any security purpose (only for non-security checksums)
- SHA-1 for signatures (acceptable only for legacy TLS interop if forced)
- DES, 3DES
- RC4
- TLS 1.1 and earlier
- Custom cryptographic algorithms (use vetted libraries)

### 4.2 Encryption at Rest

|Data                                                    |Encryption                                                          |Key management                                                  |
|--------------------------------------------------------|--------------------------------------------------------------------|----------------------------------------------------------------|
|PostgreSQL data files                                   |LUKS full-disk encryption on VM disks                               |Key in TPM (Proxmox); break-glass copy sealed offline           |
|PostgreSQL backups (pgBackRest)                         |AES-256-CBC                                                         |Three independent keys per backup repo (Ops Runbook §8.3.1)     |
|MinIO objects                                           |Server-side encryption (SSE-S3) with site key                       |Site key derived from master in secure enclave; rotated annually|
|MinIO buckets compliance-locked                         |Same as above + object lock prevents tampering                      |n/a (lock policy is metadata)                                   |
|Valkey AOF and snapshots                                |Filesystem-level encryption (LUKS)                                  |Per VM                                                          |
|Application secrets in Git                              |SOPS with age                                                       |Age key per environment; backups in sealed envelopes            |
|TLS private keys                                        |Owned by edge / per-service; not encrypted at rest beyond filesystem|Strict filesystem ACL (mode 0400 owned by service user)         |
|`tax_id` (provider entity), `ssn` (patient if collected)|Field-level encryption using pgcrypto with site key                 |Site key in environment; rotated annually                       |
|Tokens stored in DB (DoseSpot, OAuth refresh, etc.)     |Field-level encryption                                              |Site key                                                        |

### 4.3 Encryption in Transit

|Hop                                           |Protocol                                                      |Cert authority     |
|----------------------------------------------|--------------------------------------------------------------|-------------------|
|Internet → Edge (Pangolin)                    |TLS 1.3 mandatory; TLS 1.2 fallback with strict cipher suites |Let’s Encrypt      |
|Edge → Backend                                |mTLS 1.3                                                      |Private CA         |
|Backend → DB                                  |TLS 1.3 with cert verification                                |Private CA         |
|Backend → Valkey                              |TLS with `requirepass`                                        |Private CA         |
|Backend → MinIO                               |TLS 1.3                                                       |Private CA         |
|Backend → Workers                             |mTLS 1.3                                                      |Private CA         |
|Backend → External (Anthropic, DoseSpot, etc.)|TLS 1.3; certificate pinning where vendor supports stable cert|Public CA + pinning|
|Replication PG primary → replica              |TLS 1.3                                                       |Private CA         |

**HSTS:**

- Strict-Transport-Security on all customer-facing endpoints
- `max-age=63072000; includeSubDomains; preload`
- Submitted to HSTS preload list

**Cipher suite restrictions (TLS 1.2 fallback):**

- ECDHE-ECDSA-AES256-GCM-SHA384
- ECDHE-RSA-AES256-GCM-SHA384
- ECDHE-ECDSA-CHACHA20-POLY1305
- ECDHE-RSA-CHACHA20-POLY1305

All non-PFS, non-AEAD suites disabled.

### 4.4 Hashing and KDF

- **Passwords:** Argon2id (preferred); bcrypt cost 12 (fallback for older sessions in migration period)
- **Session tokens:** random 256-bit value from CSPRNG; stored hashed (SHA-256) in DB for lookup
- **Idempotency keys:** stored as SHA-256 hashes of `(org_id, key, body)` to prevent forgery
- **Backup integrity:** SHA-256 of backup files for tamper detection (separate from encryption)
- **File integrity:** SHA-256 of documents; stored alongside metadata

### 4.5 Key Hierarchy

```
Root keys (offline, sealed):
  ├── Backup encryption master keys (3 keys for 3 repos)
  ├── SOPS age private key
  ├── Private CA root signing key
  └── Field encryption master key

Operational keys (online, in secret stores):
  ├── Database encryption keys (LUKS keyslots)
  ├── Per-tenant MinIO access keys
  ├── Per-service mTLS certs and keys
  ├── Session signing secret (Better Auth)
  ├── JWT signing keys (if used for service tokens)
  └── HMAC keys for webhook signing
```

Root keys never on production systems. Compromise of any operational key bounded by what it controls.

### 4.6 Random Number Generation

All security-sensitive randomness uses OS CSPRNG:

- Node/Bun: `crypto.randomBytes()`, `crypto.randomUUID()`
- PostgreSQL: `gen_random_uuid()`, `gen_random_bytes()`
- Python workers: `secrets` module (never `random` for security)

Prohibited:

- `Math.random()` for any security purpose
- Custom PRNG implementations
- Predictable seeds

### 4.7 Cryptographic Code Standards

- Use vetted libraries (Node `crypto`, libsodium, OpenSSL via Node `crypto`)
- Never roll custom cryptographic primitives
- All cryptographic code reviewed by Security Owner
- Constant-time comparisons for secret comparison (`crypto.timingSafeEqual`)
- IVs/nonces generated per-message with CSPRNG, never reused
- Authenticated encryption (GCM or AEAD) always — never unauthenticated encryption

-----

## 5. Authentication & Session Security

### 5.1 Authentication Architecture

Module 2 (Identity & Organization) owns authentication implementation; this section is the security contract.

#### 5.1.1 Authentication Factors

|Factor            |Type                       |Used by                                                |
|------------------|---------------------------|-------------------------------------------------------|
|Password          |Something you know         |All users (with restrictions per role)                 |
|TOTP (RFC 6238)   |Something you have         |All clinical/admin users                               |
|WebAuthn / Passkey|Something you have         |Required for platform_ops, org_admin; available to all |
|SMS code          |Something you have (weaker)|Fallback only; phasing out per NIST SP 800-63B guidance|
|Biometric (mobile)|Something you are          |Local to device; supplements server-side auth          |

#### 5.1.2 Authentication Requirements by Role

|Role                                      |Minimum factors                                    |Required factors                     |
|------------------------------------------|---------------------------------------------------|-------------------------------------|
|`platform_ops` (WardenX staff)            |Password + Passkey (preferred) or Password + TOTP  |Passkey strongly recommended         |
|`org_admin`                               |Password + TOTP (Passkey preferred)                |TOTP minimum                         |
|`clinical_*` (RN, MD, MSW, chaplain, etc.)|Password + TOTP                                    |TOTP required for first sign-in setup|
|`field_staff` (aides, volunteers)         |Password + TOTP (TOTP can be SMS for accessibility)|Per agency policy                    |
|`patient_portal_user`                     |Password (optional 2FA)                            |2FA strongly recommended             |
|`external_collaborator` (magic-link)      |Magic link + email verification                    |Single-use, time-bound               |

#### 5.1.3 Password Requirements

Per NIST SP 800-63B current guidance:

- Minimum 12 characters
- No maximum length below 64 characters
- Allow all printable ASCII + Unicode
- No composition rules (no mandatory uppercase/digit/symbol) — encourage length over complexity
- Check against breach corpus (HaveIBeenPwned k-anonymity API) on creation and change
- Reject common passwords (top 10,000 list)
- No password expiration (per NIST — expiration reduces security in practice)
- Account-bound rate limiting

#### 5.1.4 Session Management

|Property               |Value                                                                  |
|-----------------------|-----------------------------------------------------------------------|
|Session ID             |256-bit CSPRNG random                                                  |
|Session storage        |DB (canonical) + Valkey (hot cache)                                    |
|Cookie attributes      |HttpOnly, Secure, SameSite=Strict, Path=/                              |
|Session token in cookie|Yes, signed                                                            |
|CSRF token             |Required for all state-changing requests; double-submit cookie pattern |
|Idle timeout           |15 minutes (all clinical sessions); biometric re-auth on mobile         |
|Absolute timeout       |8 hours work-session; 24-hour maximum                                  |
|Concurrent sessions    |Allowed but trackable; user can list and terminate from settings       |
|Session binding        |IP prefix + user-agent (loose match to allow mobile carrier IP changes)|
|Logout                 |Server-side invalidation; clears Valkey and marks DB record            |
|Sign-out everywhere    |Available — invalidates all of user’s sessions                         |

#### 5.1.5 Account Lifecycle Events

|Event                   |Audit                  |Notification               |Re-auth required             |
|------------------------|-----------------------|---------------------------|-----------------------------|
|Account created         |Yes                    |Email to user + admin      |n/a                          |
|Email changed           |Yes (with before/after)|Email to both old and new  |Re-auth recently             |
|Password changed        |Yes (no values)        |Email                      |Yes                          |
|2FA enrolled            |Yes                    |Email                      |Yes                          |
|2FA disabled            |Yes                    |Email + admin alert        |Yes + extended grace check   |
|Passkey added           |Yes                    |Email                      |Yes                          |
|Login from new device   |Yes                    |Email                      |Optional re-auth             |
|Login from new geography|Yes                    |Email + may require re-auth|Optional                     |
|Suspended               |Yes                    |Email + admin              |n/a                          |
|Reactivated             |Yes                    |Email                      |Re-auth required on first use|

#### 5.1.6 Account Recovery

Password recovery flow must satisfy multiple-factor verification:

1. User initiates via email field
1. Generic response: “If account exists, recovery email sent” (prevent enumeration)
1. If account exists: time-limited (15 min) magic link sent
1. Magic link click: prompts for second factor (TOTP) OR for security questions (less preferred)
1. New password set: same requirements as creation
1. All existing sessions invalidated
1. Audit + email notification

**For high-privilege roles (platform_ops, org_admin):** recovery requires out-of-band verification — typically support contact + identity check.

#### 5.1.7 Magic-Link Authentication (External Collaborators)

For external clinical/regulatory collaborators (Module 7.6 External Collaborator Pattern):

- Magic links single-use, time-limited (typically 30 min - 24 hr depending on scope)
- Scope embedded in link signature
- Recipient verified via known email or phone
- Session created for that specific scope only; cannot escalate
- Full audit of all actions during magic-link session
- Invalidatable by issuing org_admin

### 5.2 Session Hijacking Defense

- Cookie attributes prevent CSRF (`SameSite=Strict`) and theft via XSS (`HttpOnly`)
- Token rotation on privilege escalation (e.g., sudo into admin context)
- Re-authentication required for sensitive actions (export, role change, password change)
- Session anomaly detection: same session from two different IPs simultaneously → forced re-auth
- Mobile biometric re-auth on app foreground after 15 min idle
- Session list visible to user; user can revoke individual sessions

### 5.3 Authentication Attack Defenses

#### 5.3.1 Brute Force / Credential Stuffing

- Per-username rate limit: 5 failed attempts per 10 min → 15 min lockout
- Per-IP rate limit: 30 failed attempts per 10 min → temporary block
- Captcha after 3 failed attempts (invisible Cloudflare Turnstile preferred)
- Velocity monitoring: spike in failed logins across many accounts → defensive mode (mandatory captcha for all)

#### 5.3.2 Phishing

- HSTS preload prevents downgrade attacks
- DMARC, SPF, DKIM on email domains to prevent spoofing
- Passkey adoption (phishing-resistant by design) prioritized for high-privilege roles
- Workforce training (annual; per §164.308(a)(5))
- Email link warnings: WardenX emails always link to `*.wardenx.app`; never to third parties

#### 5.3.3 Session Token Theft

- HttpOnly cookies prevent JS access
- No `localStorage` or `sessionStorage` for session tokens
- Mobile: tokens in Capacitor SecureStore (iOS Keychain / Android EncryptedSharedPreferences)
- Server-side session revocation always available

-----

## 6. Authorization Security

### 6.1 Three-Layer Authorization (Architecture §7.9)

|Layer                     |Implementation                          |Granularity                                                |Failure mode                                |
|--------------------------|----------------------------------------|-----------------------------------------------------------|--------------------------------------------|
|**RBAC** (role-based)     |Module 3 with roles defined in code + DB|Coarse — “RN can sign encounters”                          |Wrong role → action denied                  |
|**ABAC** (attribute-based)|Module 3 with server-side predicates    |Fine — “RN can sign THIS encounter if assigned to caseload”|Predicate fails → action denied             |
|**RLS** (row-level)       |PostgreSQL policies (Module 1 §3.11)    |Database-enforced — “rows must match org context”          |Query returns 0 rows / INSERT/UPDATE blocked|

Layers are independent. Authorization in application is the primary gate; RLS is defense-in-depth backstop. **A single layer failing must not cause data exposure.**

### 6.2 Authorization Decision Standards

Every API endpoint must:

1. Be marked with explicit authorization requirement in route definition (role + ABAC predicate)
1. Reject unauthenticated requests with 401 (UnauthorizedError)
1. Reject authenticated-but-unauthorized requests with 403 (ForbiddenError)
1. Not leak existence of resources (404 vs 403 disambiguation)
1. Log authorization decisions to audit at appropriate severity

```typescript
// Example route with explicit authorization
fastify.route({
  method: 'POST',
  url: '/api/v1/patients/:id/admit',
  schema: { /* ... */ },
  preHandler: [
    authenticate,                        // 401 if no session
    requireRole(['admissions_nurse', 'rn', 'org_admin']),  // 403 if wrong role
    requireAbac('admission.create', {     // 403 if predicate fails
      predicate: (ctx, params) => {
        // Server-side predicate evaluation
        return canAdmitPatient(ctx, params.id)
      }
    }),
  ],
  handler: async (req, reply) => {
    // RLS still applies at DB layer — defense in depth
    return await withOrgContext(db, req.context, async (tx) => {
      // ... patient admission logic
    })
  }
})
```

### 6.3 Authorization Bypass Defenses

- **No client-trusted authorization** — frontend may hide UI for unauthorized actions, but server must independently authorize every request
- **Object-level authorization** — every API that operates on a specific resource (`/patients/:id`) verifies the actor’s authorization to that specific resource (not just to the resource type)
- **IDOR (Insecure Direct Object Reference) testing** — every PR with a new resource endpoint tested for IDOR: enumerate IDs, attempt access as non-authorized user, verify 404 or 403
- **Authorization in queries, not after** — `WHERE` clauses include authorization predicate, not “fetch then filter” which can have leak windows

### 6.4 Privileged Operations

Operations requiring elevated authorization (org_admin minimum, often with audit + notification):

- Role changes (granting/revoking roles)
- Patient record exports (DSAR, portability)
- Bulk operations (mass deletion, bulk update)
- Feature flag changes
- Tenant configuration changes
- External collaborator invitations
- Magic-link issuance for external access
- Document signing on behalf of others (proxy signing for visiting clinicians)
- Override of validation framework rules (Architecture §11.A claim overrides)

All privileged operations:

- Audit at `severity=warn` or `severity=critical`
- Notify org_admin (or platform_ops for platform-level operations)
- Often require re-authentication or step-up authentication

### 6.5 Service-to-Service Authorization

Backend ↔ Workers communication uses mTLS + bearer token:

- mTLS certificate identifies the calling service
- Bearer token authenticates the specific request and carries correlation/org/user context
- Tokens are short-lived (minutes) and signed
- Workers verify both mTLS cert and bearer token signature before processing

-----

## 7. Network Security

### 7.1 Trust Zone Architecture (System Design §3.1, restated)

|Zone               |Purpose                       |Inbound allowed               |Outbound allowed                               |
|-------------------|------------------------------|------------------------------|-----------------------------------------------|
|**Public**         |Internet                      |n/a                           |n/a                                            |
|**DMZ (VLAN 10)**  |Edge (Pangolin)               |443/TCP from Internet         |TLS to App zone                                |
|**App (VLAN 20)**  |Backend, Workers              |mTLS from DMZ; mTLS from peers|TLS to Data; TLS to Internet (external vendors)|
|**Data (VLAN 30)** |DB, Valkey, MinIO             |TLS from App only             |No Internet egress                             |
|**Admin (VLAN 40)**|Observability, Backups, MLflow|mTLS from App                 |No Internet egress                             |
|**Mgmt (VLAN 99)** |VM management interfaces      |SSH/Proxmox admin only        |No Internet egress                             |

**Critical:** Data zone has NO Internet egress. Even if DB compromised, attacker cannot exfiltrate directly — must pivot through App zone where audit and monitoring catch it.

### 7.2 Firewall Rules

Default deny; explicit allow per rule. Documented in `infra/firewall/rules.yaml`:

```yaml
# Sample rules
- name: edge_inbound_https
  from: any
  to: VLAN_10
  port: 443/tcp
  protocol: tls
  action: allow

- name: edge_to_app_backend
  from: VLAN_10
  to: VLAN_20
  port: 4181/tcp
  protocol: mtls
  action: allow

- name: app_to_db_postgres
  from: VLAN_20
  to: VLAN_30 (specific db hosts only)
  port: 5432/tcp
  protocol: tls
  action: allow

- name: app_to_external_anthropic
  from: VLAN_20
  to: api.anthropic.com
  port: 443/tcp
  protocol: tls
  action: allow

# Implicit: everything else deny
```

### 7.3 Network Monitoring

- **Edge logs** — Pangolin access log shipped to Loki
- **NetFlow / VPC Flow Logs** equivalent for Proxmox — `nft` accounting rules
- **IDS** — Suricata or equivalent on edge VM (Phase 2; manual log review only in Phase 1)
- **Anomaly detection** — unusual egress (data zone trying to talk to Internet), unusual inbound patterns, sustained connection volume spikes

### 7.4 Edge / DDoS Protection

**Phase 1:**

- Pangolin with rate limiting per IP and per route
- Basic protection against well-known abuse patterns

**Phase 2:**

- Cloudflare or equivalent CDN in front of Pangolin
- WAF rules for OWASP Top 10
- DDoS protection at network edge
- Geo-blocking (US-only if appropriate per customer base)

### 7.5 DNS Security

- DNSSEC on `wardenx.app` zone (Phase 2)
- CAA records restricting Certificate Authorities permitted to issue certs for the domain
- TTL configured to support failover (60 sec for failover-critical records; 300 sec for stable)
- DMARC reject policy for `@wardenx.app` email after SPF/DKIM verified
- SPF: explicit allow-list of mail-sending IPs (Postmark)
- DKIM: signing keys per environment

### 7.6 Internal Service Mesh

Backend ↔ Workers communication considered “internal mesh”:

- All communication mTLS authenticated
- Service discovery via internal DNS (10.10.X.X scheme)
- No service exposes a port outside its trust zone
- Health check endpoints on internal-only ports

-----

## 8. Data Security & PHI Handling

### 8.1 Data Classification

|Class            |Description                                      |Handling                                                                               |Examples                                                                     |
|-----------------|-------------------------------------------------|---------------------------------------------------------------------------------------|-----------------------------------------------------------------------------|
|**PHI-Critical** |Health information about identifiable individuals|Strictest controls; encryption everywhere; minimum-necessary access; audit every access|Encounter notes, diagnosis codes, medications, lab results, names, MRNs, DOBs|
|**PHI-Sensitive**|Especially sensitive PHI                         |Additional controls beyond standard PHI                                                |42 CFR Part 2 SUD records, mental health, HIV status, abuse history          |
|**Confidential** |Internal data not for public                     |Encrypted at rest; access-controlled                                                   |Financial reports, security configurations, BAA terms                        |
|**Restricted**   |Sensitive but lower-stakes                       |Access-controlled                                                                      |Operational metrics, internal documentation                                  |
|**Internal**     |Day-to-day operational                           |Standard handling                                                                      |Anonymized analytics, public documentation drafts                            |
|**Public**       |Intended for public                              |No restrictions                                                                        |Marketing copy, public docs, OSS contributions                               |

### 8.2 PHI Handling Rules

#### 8.2.1 Collection

- Only collect PHI necessary for the documented purpose
- Document the purpose at point of collection (consent for portal access, treatment, payment, healthcare operations)
- Patient/legal-representative consent captured where required (Module 39)

#### 8.2.2 Use

- Access on a need-to-know basis per role + caseload + context (RBAC + ABAC)
- Audit every access (Module 4)
- Minimum necessary principle: query for specific data needed, not the whole chart

#### 8.2.3 Disclosure

- Internal: per authorization model; audited
- External: per consent (Module 39) + appropriate technical safeguards (encrypted transmission, recipient verification, audit)
- To business associates: only via signed BAA
- Specific exceptions per HIPAA Privacy Rule documented per case

#### 8.2.4 Retention and Destruction

- Per Architecture §24 Data Retention Matrix
- Destruction certification per HIPAA §164.310(d)(2)(i)
- Destruction methods (cryptographic erasure for keyed data, secure deletion for non-encrypted)

#### 8.2.5 PHI in Special Contexts

|Context                   |Rule                                                                             |
|--------------------------|---------------------------------------------------------------------------------|
|Logs (system, application)|Never log PHI in plain; Pino redact list (Module 1 §8.5)                         |
|Spans (OpenTelemetry)     |Never put PHI in span names or attributes                                        |
|Sentry errors             |`beforeSend` redacts PHI from context                                            |
|Anthropic prompts         |Per WARDENX_AI_GOVERNANCE; minimization rules apply                              |
|Email subject lines       |Never PHI; subject is generic (“New message from your care team”)                |
|Email body                |Encrypted via TLS; minimal PHI; full chart accessed via authenticated portal link|
|Push notifications        |Never PHI in notification body; “You have a new message” + link to app           |
|SMS body                  |Never PHI; just generic notification                                             |
|URL paths                 |Resource UUIDs OK (not PHI); names/MRNs/DOBs never                               |
|Browser console           |Never PHI in console.log; lint rule blocks                                       |
|Backup file names         |Never PHI; UUIDs/timestamps only                                                 |

### 8.3 Data Minimization

- API endpoints return only fields requested or needed for the operation
- Field-level access controls — some fields restricted even within authorized records (e.g., SSN visible to billing role only)
- Bulk operations return summarized data, not full records, unless explicitly needed
- Background jobs operate on minimum necessary projections

### 8.4 Anonymization & De-identification

When data is used for analytics, research, or AI training:

- **Safe Harbor de-identification** (HIPAA §164.514(b)(2)) — 18 specific identifiers removed
- **Expert determination** when Safe Harbor too restrictive — requires qualified statistician
- **Re-identification controls** — anonymized datasets segregated from identifiable; recombination requires controlled access
- **AI training data:** WardenX’s own AI improvement (e.g., HearthNote drift monitoring) uses de-identified data only or operates within tenant scope; never cross-tenant pooled

### 8.5 PHI Export Controls

Bulk export of PHI is a privileged operation with explicit controls:

#### 8.5.1 Export Types

|Type                                |Authorization                                               |Audit                 |Workflow                                             |
|------------------------------------|------------------------------------------------------------|----------------------|-----------------------------------------------------|
|Single record export (clinical)     |RN, MD, or admin role within tenant                         |`phi.exported`        |Standard route; direct download                      |
|Patient DSAR (HIPAA Right of Access)|Org admin or designated DSAR officer                        |`phi.dsar_fulfilled`  |Identity verification first; specific patient(s)     |
|Tenant data migration export        |Org admin + WardenX support                                 |`phi.tenant_export`   |Coordinated; tenant exit workflow (Ops Runbook §11.3)|
|Bulk research export                |Org admin + IRB documentation + research consent (Module 39)|`phi.research_export` |Manual approval flow; de-identification step         |
|Analytics dataset                   |Platform_ops only; de-identified data only                  |`phi.analytics_export`|Restricted to de-identified pipelines                |

#### 8.5.2 Export Workflow

For any bulk export (>10 records):

1. Justification required (free text)
1. Approving authority recorded (per type above)
1. Export operation rate-limited (1 per hour per user)
1. Export size limit (default 10,000 records; exceeding requires elevated approval)
1. Generated file encrypted at rest in MinIO (`tenants/<org>/exports/`)
1. Download tracked: who downloaded, when, from where (IP)
1. Time-limited download URL (24 hours)
1. File auto-deleted from MinIO after 7 days
1. Audit entry with severity=warn for moderate exports, severity=critical for >1000 records

### 8.6 Cross-Tenant Data Isolation

**Three-layer defense (Architecture §3 Tenancy Model):**

1. Application authorization (Module 3) — primary
1. Service layer `withOrgContext()` (Module 1 §3.13) — sets `app.org_id` for RLS
1. Database RLS policies — backstop

**Validation:**

- Every PHI-bearing module has RLS isolation test suite (Module 1 §9.3)
- CI blocks merge if RLS tests fail
- Quarterly audit: random sample of 100 queries across all backends, verify all RLS-policy-evaluated
- Penetration test attempts cross-tenant access (Phase 2)

### 8.7 PHI in Backups

- Backups encrypted (§4.2) with keys not on production systems
- Backup access requires `wardenx_admin` role + break-glass (Ops Runbook §8.5)
- Restore operations audited with severity=warn
- Test restores to sandbox verify decryption + data integrity

-----

## 9. Application Security

### 9.1 Secure SDLC

#### 9.1.1 Design Phase

- Threat modeling for every new module (per Module Spec Template §2 Domain Model + §6 Permissions)
- Security review for any module touching PHI
- ADR for security-affecting architectural decisions

#### 9.1.2 Implementation Phase

- Code follows patterns catalog (Architecture §25)
- Mandatory:
  - `withOrgContext()` for PHI queries
  - Typed error classes (no string throws)
  - Idempotency keys for mutations
  - Authorization decorators on every route
  - Audit emission for state changes

#### 9.1.3 Review Phase

Every PR with security implications reviewed by Security Owner (Fabrice currently). Specifically required for:

- Authentication / authorization changes
- New API endpoints touching PHI
- New external integrations
- Changes to logging / observability
- Cryptographic code
- RLS policy changes
- Migration scripts that modify access controls

#### 9.1.4 Testing Phase

- Unit tests for security logic (auth checks, encryption, validation)
- Integration tests with Testcontainers
- RLS isolation tests (cross-tenant denial)
- E2E tests for security flows (login, MFA, session timeout)
- Performance / load tests with security observability
- Security-specific tests: input validation, injection, IDOR

#### 9.1.5 Pre-Deploy Phase

- CI must pass all security scans
- SBOM generated and signed
- Container signed with cosign
- Vulnerability scan results within tolerance

### 9.2 Static Application Security Testing (SAST)

Tools:

- **Biome** linter with custom security rules (no `eval`, no `Math.random` for security, etc.)
- **Semgrep** with healthcare/security rulesets — Phase 1 manual; Phase 2 in CI
- **CodeQL** (GitHub) — Phase 2 in CI
- **Custom rules** for WardenX-specific patterns (e.g., RLS context required)

Findings:

- Critical: block merge
- High: block merge unless explicit waiver from Security Owner
- Medium: must be triaged before merge; can defer with ticket
- Low: noted; tracked for batch remediation

### 9.3 Software Composition Analysis (SCA)

- **npm audit** / **bun audit** in CI
- **Snyk** or **Dependabot** for dependency advisories
- **Renovate** for routine dependency updates
- **Trivy** or **Grype** for container image scanning

CVE response:

- Critical (CVSS ≥ 9.0): patch within 72 hours
- High (7.0-8.9): patch within 7 days
- Medium (4.0-6.9): patch within 30 days
- Low (<4.0): patch within next minor release

### 9.4 Dynamic Application Security Testing (DAST)

- **OWASP ZAP** automated scans in staging — Phase 2
- **Manual exploratory testing** quarterly — Phase 1 (Fabrice + future consultant)
- **Penetration test** annual — Phase 2+ (see §15)

### 9.5 Common Vulnerability Defenses

#### 9.5.1 Injection

- All DB access via Drizzle ORM with parameterized queries — never string concatenation
- All user input validated against TypeBox schemas at API boundary
- Output encoding (React handles HTML escaping by default; verify no `dangerouslySetInnerHTML` with user data)
- Command injection: never `exec()` with user input

#### 9.5.2 Broken Access Control (OWASP A01)

- Server-side authorization (§6)
- IDOR testing per route
- RLS backstop

#### 9.5.3 Cryptographic Failures (OWASP A02)

- §4 standards enforced
- No custom crypto
- Code review for crypto code

#### 9.5.4 Insecure Design (OWASP A04)

- Threat modeling at design phase
- Pattern catalog adherence
- Security review

#### 9.5.5 Security Misconfiguration (OWASP A05)

- Infrastructure as code (Ansible, Terraform when applicable)
- CIS benchmark baselines (§10)
- Configuration drift detection

#### 9.5.6 Vulnerable Components (OWASP A06)

- SCA (§9.3)
- Patch SLA

#### 9.5.7 Identification & Authentication Failures (OWASP A07)

- §5 controls
- Penetration test focus

#### 9.5.8 Software & Data Integrity Failures (OWASP A08)

- Image signing
- SBOM
- Forward-only migrations
- Audit immutability

#### 9.5.9 Security Logging & Monitoring Failures (OWASP A09)

- §11 audit security
- Alert tuning (Ops Runbook §9.2)

#### 9.5.10 Server-Side Request Forgery — SSRF (OWASP A10)

- Outbound HTTP from app zone restricted by firewall to known vendors
- No “fetch any URL” features
- Internal services not reachable from app zone except via service mesh

### 9.6 Frontend / Client Security

#### 9.6.1 CSP (Content Security Policy)

Strict CSP header on all customer-facing endpoints:

```
Content-Security-Policy: default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https://*.wardenx.app;
  font-src 'self';
  connect-src 'self' wss://*.wardenx.app https://api.anthropic.com;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  report-uri /api/v1/security/csp-report;
```

#### 9.6.2 Other Security Headers

- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(self), payment=()`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`

#### 9.6.3 XSS Defense

- React’s default escaping (never `dangerouslySetInnerHTML` with user data)
- DOMPurify for any user content that must be rendered as HTML (e.g., rich-text notes)
- CSP as defense in depth

#### 9.6.4 CSRF Defense

- `SameSite=Strict` cookies
- Double-submit CSRF token for state-changing requests
- Origin / Referer header validation

#### 9.6.5 Local Storage / Session Storage

- **Never** store session tokens in `localStorage` or `sessionStorage`
- Lint rule blocks usage for security purposes
- Capacitor mobile: tokens in SecureStore only

### 9.7 API Security

- Versioning: `/api/v1/` explicit; breaking changes increment version
- Rate limiting per route and per identity (System Design §6.6)
- Request size limits (default 10 MB; larger for specific document upload routes with explicit limits)
- TypeBox schemas validate every request body and response
- Idempotency keys for mutations
- Webhook signing verification on all inbound webhooks (System Design §6.7)

-----

## 10. Container & Image Security

### 10.1 Image Build Standards

```dockerfile
# Standard backend Dockerfile pattern
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN bun run build

FROM gcr.io/distroless/nodejs22-debian12 AS runtime
WORKDIR /app
COPY --from=builder /app/dist /app
COPY --from=builder /app/node_modules /app/node_modules
USER nonroot:nonroot
EXPOSE 4181
ENTRYPOINT ["node", "/app/index.js"]
```

Standards:

- **Distroless base** — no shell, no package manager in runtime image
- **Non-root user** — `USER nonroot:nonroot`
- **No secrets in image** — secrets injected at runtime via mounted files or env
- **Multi-stage builds** — build tools not in final image
- **Pinned base image** (use specific digest, not `:latest`)
- **Minimum installed packages**

### 10.2 Image Signing

```bash
# Sign image on CI publish
cosign sign --key cosign.key ghcr.io/wardenx/backend:<sha>

# Verify before deploy
cosign verify --certificate-identity=<identity> \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  ghcr.io/wardenx/backend:<sha>
```

Signing pipeline:

- CI signs every image on push to `main`
- Production deploy verifies signature before pulling image
- Signing key in HSM or KMS (currently: GitHub Actions OIDC with keyless signing)

### 10.3 SBOM (Software Bill of Materials)

CycloneDX format, generated in CI:

```bash
# In CI pipeline
syft ghcr.io/wardenx/backend:<sha> -o cyclonedx-json > backend-sbom.json
```

SBOM:

- Attached to image manifest as annotation
- Stored as build artifact in GitHub Actions
- Reviewed monthly for new high-CVE components
- Provided to customers on request (security questionnaire response)

### 10.4 Image Scanning

```bash
# Trivy scan in CI
trivy image --severity CRITICAL,HIGH --exit-code 1 ghcr.io/wardenx/backend:<sha>
```

Findings:

- CRITICAL or HIGH in production image → block merge
- MEDIUM → require triage before merge
- LOW → tracked for batch update

### 10.5 Runtime Container Security

- Containers run with `--read-only` filesystem where possible
- Writable mounts limited to specific paths (`/tmp`, log directories)
- `--cap-drop=ALL --cap-add=<specific>` — minimum capabilities
- `--security-opt=no-new-privileges`
- Network restricted to required egress
- Resource limits (CPU, memory) configured per service

### 10.6 Image Lifecycle

- Production images: retained 1 year in GHCR
- Old base images: not used after EOL of distribution
- Deprecated/vulnerable image tags: removed from GHCR

-----

## 11. Infrastructure Security

### 11.1 CIS Benchmarks

Baselines applied to all production hosts:

- **Ubuntu Server CIS Benchmark v1.1** (or current) for Proxmox VMs
- **PostgreSQL CIS Benchmark** for DB VMs
- **Docker CIS Benchmark** for container hosts
- **Proxmox best practices** (Proxmox doesn’t have an official CIS benchmark; community guides applied)

Implementation:

- Ansible roles enforce CIS baseline at VM provisioning
- Automated compliance check weekly via Ansible audit mode
- Deviations require Security Owner approval with documented rationale

### 11.2 Host Hardening Checklist

For each production VM:

- [ ] SSH: key-only (no password), specific allowed users, non-default port if reasonable
- [ ] Firewall (ufw or nftables): default deny inbound, specific allows
- [ ] Auto-updates: security patches automatic (Ubuntu unattended-upgrades)
- [ ] AIDE or similar file integrity monitoring: configured for critical paths
- [ ] Auditd: configured to log security-relevant events
- [ ] Rsyslog: shipping logs to central Loki
- [ ] Time sync: NTP / chrony configured
- [ ] Sysctl hardening: per CIS recommendations
- [ ] Unused services disabled
- [ ] Filesystem mount options: `noexec`, `nosuid`, `nodev` where applicable
- [ ] Limits on resource consumption (ulimits)

### 11.3 SSH Access

- All SSH via bastion (`wardenx-bastion-01`)
- Per-engineer SSH keys (no shared keys)
- Keys stored in YubiKey or hardware-backed where possible
- Bastion logs all sessions (recorded session logs retained per Ops Runbook §16.1)
- SSH key rotation annually
- Disabled SSH on production VMs except from bastion network

### 11.4 Sudo / Privilege Escalation

- `sudo` audited via auditd
- No NOPASSWD for production
- Time-bound sudo grants where possible

### 11.5 Antivirus / EDR

- **Phase 1:** No commercial EDR (cost/operational burden vs solo dev). Mitigations: minimal attack surface (distroless containers, hardened hosts, network segmentation), audit-based detection
- **Phase 2:** Crowdstrike, SentinelOne, or equivalent EDR on hosts handling PHI
- **Phase 3+:** XDR with SIEM integration

### 11.6 Configuration Drift Detection

- Ansible runs in check mode weekly to detect drift
- Drift findings require explanation: planned change not yet documented, OR unauthorized change requiring investigation
- Auto-remediation for known-safe drift; manual review for unknown

-----

## 12. Mobile Device Security (Capacitor)

### 12.1 Mobile Architecture Recap

`apps/mobile/` is a Capacitor-wrapped TanStack Start application delivered as native iOS and Android apps via App Store / Google Play (or MDM for enterprise distribution). Used by clinical and field staff. Stores temporary clinical data offline.

### 12.2 Device Posture Requirements

For app to function, device must meet:

- **OS version**: iOS 16+, Android 12+
- **No jailbreak/root**: app refuses to run on compromised devices (detection: see §12.4)
- **Biometric available**: TouchID/FaceID on iOS, biometric on Android (fingerprint or face)
- **Screen lock enabled**: PIN/passcode required by OS
- **App-level data encryption supported**: SecureStore / EncryptedSharedPreferences

### 12.3 App Security Controls

#### 12.3.1 Local Data Encryption

- Session token, refresh token, biometric-unlock secret → **SecureStore** (iOS Keychain hardware-backed where available; Android EncryptedSharedPreferences backed by Keystore)
- Encounter drafts (when offline) → encrypted SQLite via Capacitor SQLite plugin with sqlcipher
- Cached patient context → encrypted SQLite, evicted on logout
- Photos awaiting upload → encrypted in app sandbox; uploaded then deleted

#### 12.3.2 Biometric Authentication

- Required on app launch
- Re-prompted after 15-minute idle
- Re-prompted on app foreground if previous foreground was >15 min ago
- Failed biometric → password fallback; 5 failed attempts → app sign-out

#### 12.3.3 Session Idle Timeout

- App-level idle timeout: 15 minutes of no interaction → require biometric to resume
- Backend session: 15-minute idle, 8-hour work-session, 24-hour absolute (server-enforced)
- Absolute session timeout: 24 hours

#### 12.3.4 Screen Capture Prevention

- iOS: app marks views containing PHI with `UIScreen.isCaptured` listeners; warning shown to user; option to obfuscate when screen recording detected
- Android: `FLAG_SECURE` set on activities displaying PHI — prevents screenshots and screen recording in recent apps
- Defense in depth; not foolproof (jailbroken device can bypass)

#### 12.3.5 Certificate Pinning

- Backend API endpoints pinned to specific certificate or CA
- Pinning enforced via Capacitor Network plugin custom config
- Pinning updates when certs rotate (coordinated deploy)

#### 12.3.6 Anti-Tampering

- Code obfuscation in release builds (iOS: bitcode + Swift; Android: R8)
- Native code integrity checks at launch
- API response integrity (TLS handles transit; app verifies certain critical responses are signed by backend)

### 12.4 Jailbreak / Root Detection

App refuses to run on compromised devices:

```typescript
// Pseudocode for detection (Capacitor + RootBeer-equivalent / IOSSecuritySuite)
async function deviceIntegrityCheck() {
  if (await isJailbroken()) {
    showBlockingScreen('This app cannot run on jailbroken devices for patient safety.')
    return false
  }
  if (await isRooted()) {
    showBlockingScreen('This app cannot run on rooted devices for patient safety.')
    return false
  }
  if (await isEmulator()) {
    showBlockingScreen('This app cannot run on emulators.')
    return false
  }
  return true
}
```

Detection methods:

- iOS: checks for jailbreak files, dynamic linker tampering, sandbox violations
- Android: checks for su binary, Magisk, dangerous mounts, debug flags

Known limitations:

- Sophisticated jailbreak hides from detection (e.g., Liberty Lite)
- Detection is defense in depth, not infallible
- Combined with audit at server side (unusual access patterns from clinical mobile may flag)

### 12.5 Lost / Stolen Device Procedure

#### 12.5.1 User-Initiated

In WardenX user settings:

- “Sign out of this device” (per-device session revocation)
- “Sign out everywhere” (all sessions invalidated)
- “Forget my device” (removes device from trusted device list)

#### 12.5.2 Org-Admin-Initiated

Org admin can:

- View list of active sessions per user with device fingerprint and last activity
- Revoke specific session
- Lock the user (sign-out everywhere; requires password reset)

#### 12.5.3 MDM Integration (Future)

For enterprise customers (Phase 3):

- Mobile Device Management integration
- Remote wipe of WardenX app data only (not full device wipe — that’s customer’s IT decision)
- Forced sign-out on policy violation (e.g., device left organization)

### 12.6 App Distribution

- **iOS:** App Store distribution + per-tenant enterprise distribution via Apple Business Manager (Phase 2)
- **Android:** Google Play Store + APK distribution for enterprise (Phase 2)
- **Beta:** TestFlight (iOS) / Internal Testing (Android) for pre-release

### 12.7 Mobile Audit Trail

All mobile actions audited identically to web actions, plus:

- Device fingerprint (model, OS version)
- App version
- Connection state (online/offline at action time)
- Geofence status (Module 18 EVV)

### 12.8 Mobile App Update Cadence

- Security patches: forced update within 7 days
- Critical features: forced update within 30 days
- Standard updates: opt-in
- Mechanism: backend returns minimum-app-version in API response; app prompts upgrade if below

-----

## 13. Audit Security

### 13.1 Audit Integrity Controls

|Control                    |Implementation                                                     |
|---------------------------|-------------------------------------------------------------------|
|Append-only at DB layer    |`wardenx_app` role has only INSERT, SELECT on `audit_event`        |
|Append-only at architecture|No application code path modifies historical audit                 |
|Partition immutability     |Partitioned table; partitions detached for archival, never modified|
|Backup as cross-reference  |pgBackRest archive provides historical state for tamper detection  |
|Audit of audit access      |Elevated access to audit table itself logged as meta-event         |
|Cryptographic seal (future)|Hash chain over audit events; planned Phase 3                      |

### 13.2 Audit Completeness

Every PHI access and every state change must produce an audit entry. Mechanism:

- `audit()` helper in `packages/db/src/audit.ts` (Module 1)
- Service-layer pattern: every domain action that touches PHI calls `audit()` before commit
- Code review enforces this
- Lint rule (custom) flags PHI table mutations without nearby `audit()` call
- Integration tests verify expected audit emission

### 13.3 Audit Review

|Frequency        |Reviewer                            |Focus                                                                  |
|-----------------|------------------------------------|-----------------------------------------------------------------------|
|Daily (automated)|n/a                                 |High-severity events alerted real-time                                 |
|Weekly           |On-call                             |Anomaly summaries from prior week                                      |
|Monthly          |Compliance Officer                  |Random sample of high-risk events (admin actions, exports, RLS denials)|
|Quarterly        |Compliance + Engineering            |Pattern review across categories                                       |
|Annually         |External auditor (when SOC 2 sought)|Full audit of audit                                                    |

### 13.4 Anomaly Detection

#### 13.4.1 Specific Patterns Monitored

- **Bulk exports:** any export > 100 records flagged for review
- **Off-hours access:** access between 22:00-06:00 local agency time flagged
- **New geography:** login from country not seen in past 90 days flagged
- **Failed RLS:** any nonzero RLS denial rate alerted
- **Privilege use:** every use of platform_ops or org_admin role logged + reviewed
- **API rate spikes:** unusual access rate by single user
- **Same-user concurrent sessions from different IPs:** flagged for re-auth

#### 13.4.2 Implementation

Module 4 (Audit) provides the data layer. Anomaly detection is a Phase 2 enhancement implemented as scheduled BullMQ jobs that:

1. Query audit data from prior interval
1. Apply detection rules
1. Generate alerts for matches
1. Emit `security.anomaly_detected` events with severity per rule
1. Route to ops + compliance per severity

-----

## 14. Vulnerability Management

### 14.1 Vulnerability Sources

- **CVE feeds:** subscribed via Snyk / Dependabot
- **GHSA:** GitHub Security Advisories
- **Vendor security bulletins:** Anthropic, DoseSpot, etc. via security mailing lists
- **CISA / NIST:** Known Exploited Vulnerabilities catalog watched
- **Internal:** code review findings, scan findings, pentest findings, bug bounty (future)

### 14.2 Vulnerability Triage SLA

|Severity                   |Response                                                      |Remediation SLA|
|---------------------------|--------------------------------------------------------------|---------------|
|Critical (CVSS 9.0+) or KEV|Same-day investigation; emergency patch process if exploitable|72 hours       |
|High (7.0-8.9)             |1 business day investigation                                  |7 days         |
|Medium (4.0-6.9)           |1 business week investigation                                 |30 days        |
|Low (<4.0)                 |Triaged in next patch cycle                                   |Next release   |

Exceptions:

- Network-isolated component: severity may be downgraded with documented justification
- Compensating control in place: severity may be downgraded
- All severity adjustments documented; reviewed quarterly

### 14.3 Patch Process

```bash
# Vulnerability identified
# Triage: severity confirmed, exposure assessed, remediation determined

# For dependencies:
# 1. Update package.json with patched version
# 2. Run tests
# 3. Deploy via standard or hot-fix procedure depending on SLA

# For container images:
# 1. Update base image to patched version
# 2. Rebuild
# 3. Sign and deploy

# For infrastructure (OS, libraries):
# 1. Update via Ansible role
# 2. Apply during maintenance window if can be deferred; emergency window if not
# 3. Verify post-patch

# Document in security log:
# - CVE / advisory ID
# - Description
# - Affected component
# - Remediation
# - Verification
# - Sign-off
```

### 14.4 Vulnerability Disclosure (Inbound)

Security contact: `security@wardenx.app` (PGP key published on website).

Process:

1. Acknowledge receipt within 24 hours
1. Assess severity
1. Assign remediation per SLA
1. Coordinate disclosure with reporter (responsible disclosure standard 90 days)
1. Credit reporter (with their consent) in security advisory
1. Bug bounty (future): financial recognition per Phase 3 program

-----

## 15. Penetration Testing

### 15.1 Cadence

|Phase                    |Frequency                                                          |
|-------------------------|-------------------------------------------------------------------|
|Pre-launch (now)         |None formally; manual exploratory testing by Fabrice               |
|Phase 1 (Engrace go-live)|One-time pre-launch pen test by external vendor                    |
|Phase 2 (multi-tenant)   |Annual full pen test + quarterly targeted scope                    |
|Phase 3 (SOC 2 ready)    |Continuous bug bounty + annual pen test + targeted on major release|

### 15.2 Pen Test Scope

Standard scope includes:

- **External attack surface** — internet-facing endpoints, DNS, MX
- **Web application** — OWASP Top 10, business logic flaws, authentication, authorization
- **Mobile application** — iOS and Android binaries, runtime, network communication
- **API** — all `/api/v1/` endpoints, authentication, authorization, IDOR, injection
- **Cross-tenant isolation** — explicit attempts to access other tenant data
- **Privileged operations** — privilege escalation, bypass attempts
- **AI features** — prompt injection, data exfiltration via AI

**Out of scope** (typically):

- Physical security (separate audit)
- Social engineering of customer staff (separate engagement)
- DDoS testing (production impact risk)

### 15.3 Findings Remediation

- Critical/High: remediated before next pen test (i.e., within annual cycle)
- Medium: prioritized in security backlog; planned remediation timeline
- Low: tracked; batch remediation in patch cycles
- Informational: noted; may inform documentation updates

### 15.4 Retest

- Critical/High findings retested within 30 days of remediation
- Annual full retest as part of next cycle

-----

## 16. Security Incident Response

### 16.1 Scope

Security incident response complements general incident response (WARDENX_DR_BCP §2). Security incidents include:

- Suspected unauthorized access
- PHI exposure (intentional or accidental)
- Compromised credential
- Malicious code detected
- Insider threat investigation
- Vendor security incident affecting WardenX
- Ransomware (also covered in DR_BCP §10.4.1)

### 16.2 Detection

|Source                                                 |Channel                                            |Severity expectation              |
|-------------------------------------------------------|---------------------------------------------------|----------------------------------|
|Internal monitoring (Prometheus, Sentry, audit anomaly)|Alert                                              |Per rule, typically SEV-2 to SEV-1|
|Customer report                                        |[support@wardenx.app](mailto:support@wardenx.app)  |Investigate; classify             |
|External researcher / responsible disclosure           |[security@wardenx.app](mailto:security@wardenx.app)|Triage per §14.4                  |
|Vendor notification                                    |Email, vendor portal                               |Assess impact                     |
|Public CVE / advisory                                  |Feeds                                              |Triage per §14.2                  |
|Threat intelligence                                    |Manual review                                      |Investigate if relevant           |

### 16.3 Triage Decision Tree

```
Security event reported/detected
│
├── Is PHI exposure confirmed or strongly suspected?
│   ├── YES → SEV-1; HIPAA breach assessment kicks off; counsel engaged within 1 hour
│   └── NO → Continue triage
│
├── Is unauthorized access confirmed?
│   ├── YES → SEV-1 or SEV-2 based on scope
│   └── NO → Continue triage
│
├── Is system integrity compromised (malicious code, tampering)?
│   ├── YES → SEV-1
│   └── NO → Continue triage
│
└── Is it a vulnerability with no known exploit?
    └── Triage per §14
```

### 16.4 Containment

- **Isolate affected systems** without destroying forensic state (disconnect network rather than shut down)
- **Revoke compromised credentials** immediately
- **Block attacker IP** at edge
- **Preserve logs**: ensure audit and system logs from affected period are archived to separate location

### 16.5 Investigation

- **Forensic preservation** before remediation
- **Scope determination** — which systems, which data, which timeframe
- **Root cause analysis** — how did this happen; what control failed
- **Impact assessment** — what data was potentially accessed
- **Attribution** (if external attack) — gather indicators for threat intelligence

### 16.6 Eradication & Recovery

- **Remove the vulnerability** that allowed entry (patch, config fix, code change)
- **Restore systems** from clean backups if compromised beyond cleanup
- **Reissue credentials** (every credential touched by incident)
- **Verify clean** state before returning to production

### 16.7 Notification

- **Internal:** all hands aware per severity (compliance, leadership, customer success)
- **Customer notification:** per BAA terms and HIPAA breach rule (DR_BCP §9.3)
- **Regulator notification:** per HIPAA breach rule (60-day window)
- **Law enforcement:** if criminal activity (FBI cybercrime — IC3)
- **Public disclosure:** with reporter coordination (responsible disclosure)

### 16.8 Post-Incident Review

Within 7 days of resolution:

- Timeline reconstruction
- What worked / what didn’t
- Action items with owners and dates
- Updates to threat model, controls, and this document
- Customer-facing post-incident review for SEV-1 affecting customers

-----

## 17. Admin Break-Glass Procedures

### 17.1 What Counts as Break-Glass

Use of credentials or access patterns reserved for emergency:

- `postgres` superuser role
- `wardenx_admin` outside of normal migration runner context
- MinIO root credentials
- SSH directly to production VM bypassing bastion
- Off-site age key for SOPS decryption
- pgBackRest off-site repo credentials

### 17.2 Authorization to Use

|Credential                       |Authorization                                        |Required documentation                    |
|---------------------------------|-----------------------------------------------------|------------------------------------------|
|`postgres` superuser             |Security Owner + Incident Commander (during incident)|Reason; expected duration; planned actions|
|`wardenx_admin` for non-migration|Security Owner                                       |Same                                      |
|MinIO root                       |Security Owner                                       |Same                                      |
|SSH bypassing bastion            |Security Owner (during incident only)                |Same                                      |
|Off-site age key                 |Security Owner + secondary holder                    |Reason; sealed envelope inventory check   |

### 17.3 Use Procedure

1. **Document intent** in physical security log (or secure digital equivalent)
1. **Obtain authorization** per §17.2
1. **Open sealed envelope or retrieve credential** with timestamps recorded
1. **Use credential** for specific task only
1. **Audit emission:** `security.break_glass_used` with `severity=critical`
1. **Rotate credential immediately** after use (Ops Runbook §8.2.4)
1. **Reseal new credential** in envelope
1. **Compliance review** within 24 hours
1. **Post-incident review** entry within 7 days

### 17.4 Routine vs Emergency

- **Emergency use** justified by: cannot proceed via normal channels AND time-sensitive
- **Routine use prohibited** — find a normal channel or escalate the gap

### 17.5 Audit

- Every break-glass use audited at `severity=critical`
- Monthly review by Compliance Officer
- Quarterly review with full forensic detail by Security Owner

-----

## 18. Vendor Security Management

### 18.1 Vendor Security Review

Before any vendor receives PHI access:

1. **Business case documented**
1. **Security questionnaire** sent to vendor (SIG, CAIQ, or custom)
1. **BAA executed**
1. **Encryption at rest and in transit confirmed**
1. **Vendor’s own security certifications reviewed** (SOC 2 Type II, HITRUST, ISO 27001, etc.)
1. **Subprocessor disclosure required**
1. **Incident notification SLA agreed** (typically 72 hours)
1. **Data return / destruction terms** agreed
1. **Risk approval** by Security Owner
1. **Onboarding** with credentials provisioned per least-privilege

Full detail per vendor in WARDENX_INTEGRATIONS.

### 18.2 Ongoing Vendor Monitoring

- Annual security review
- BAA renewal tracking (Ops Runbook §12.4)
- Vendor breach notifications: assess impact, communicate to affected customers
- Vendor end-of-life: plan migration well in advance

### 18.3 Vendor Offboarding

When relationship ends:

- Credentials revoked
- Data return or destruction confirmed (per BAA terms)
- Final audit log entry
- Vendor removed from active monitoring

-----

## 19. Workforce Security

### 19.1 Onboarding (HIPAA §164.308(a)(3))

For WardenX engineers/employees:

- Background check (criminal, employment, education verification)
- Reference checks
- BAA / non-disclosure / IP assignment signed
- HIPAA training before access provisioned
- Security training before access provisioned
- Least-privilege access provisioning per role
- Equipment provisioning with encrypted storage

### 19.2 Ongoing

- Annual HIPAA refresher training
- Annual security awareness training
- Quarterly access review (Ops Runbook §12.2)
- Phishing simulation (quarterly when team grows; manual for solo dev)

### 19.3 Termination (HIPAA §164.308(a)(3)(ii)(C))

Within 1 hour of termination (voluntary or involuntary):

- All access revoked: sessions, SSH keys, VPN, credentials in all systems
- Devices recovered or remotely wiped
- Knowledge transfer captured
- Exit interview including security debriefing
- Documentation in HR records (6+ year retention)

### 19.4 Sanctions Policy (HIPAA §164.308(a)(1)(ii)(C))

Formal sanctions policy:

- Documented disciplinary actions for security policy violations
- Tiered: counseling → written warning → suspension → termination
- Severity-appropriate; consistent application
- Documented per incident

### 19.5 Contractors

Same controls as employees for any contractor with PHI access:

- BAA executed
- Background check (proportional to access level)
- Training before access
- Time-bound access aligned to contract
- Quarterly review while engaged

-----

## 20. Compliance Mappings

### 20.1 HIPAA Security Rule

Cross-reference of HIPAA Security Rule sections to this document and Architecture v0.9 §23 Compliance Traceability:

|HIPAA Section                                           |Coverage                                                                                          |
|--------------------------------------------------------|--------------------------------------------------------------------------------------------------|
|§164.308(a)(1)(i) Security Management Process           |This doc §2, §3, §14                                                                              |
|§164.308(a)(1)(ii)(A) Risk Analysis                     |This doc §12 + annual HIPAA risk analysis (Ops Runbook §12.1)                                     |
|§164.308(a)(1)(ii)(B) Risk Management                   |This doc §3 + threat model + controls                                                             |
|§164.308(a)(1)(ii)(C) Sanctions                         |This doc §19.4                                                                                    |
|§164.308(a)(1)(ii)(D) Information System Activity Review|This doc §13 + Module 4                                                                           |
|§164.308(a)(2) Assigned Security Responsibility         |This doc §2.1                                                                                     |
|§164.308(a)(3) Workforce Security                       |This doc §19                                                                                      |
|§164.308(a)(4) Information Access Management            |This doc §6 + Module 3                                                                            |
|§164.308(a)(5) Security Awareness and Training          |This doc §19                                                                                      |
|§164.308(a)(6) Security Incident Procedures             |This doc §16 + DR_BCP                                                                             |
|§164.308(a)(7) Contingency Plan                         |DR_BCP entirety                                                                                   |
|§164.308(a)(8) Evaluation                               |This doc §15 + Annual review                                                                      |
|§164.310(a) Facility Access Controls                    |(Customer agencies own this for their facilities; WardenX’s data center owned by hosting provider)|
|§164.310(b) Workstation Use                             |This doc §12 (mobile) + customer agency policies                                                  |
|§164.310(c) Workstation Security                        |Same                                                                                              |
|§164.310(d) Device and Media Controls                   |This doc §8.5 (export) + Architecture §24 (retention/destruction)                                 |
|§164.312(a)(1) Access Control                           |This doc §6, §5                                                                                   |
|§164.312(a)(2)(i) Unique User Identification            |This doc §5                                                                                       |
|§164.312(a)(2)(iii) Automatic Logoff                    |This doc §5.1.4                                                                                   |
|§164.312(a)(2)(iv) Encryption and Decryption            |This doc §4                                                                                       |
|§164.312(b) Audit Controls                              |This doc §13 + Module 4                                                                           |
|§164.312(c) Integrity                                   |This doc §13, §9.5                                                                                |
|§164.312(d) Person or Entity Authentication             |This doc §5                                                                                       |
|§164.312(e) Transmission Security                       |This doc §4.3                                                                                     |

### 20.2 SOC 2 Trust Services Criteria (Readiness for Phase 3)

|TSC                 |Coverage                   |
|--------------------|---------------------------|
|Security            |This doc entirety          |
|Availability        |DR_BCP, Ops Runbook §10    |
|Processing Integrity|This doc §13, §9, Module 4 |
|Confidentiality     |This doc §4, §6, §8        |
|Privacy             |Module 39, Architecture §24|

### 20.3 HITRUST CSF (Future)

HITRUST is a longer-term aspiration (Phase 4+). Current alignment with key control families:

- Access Control: §5, §6
- Information Protection Program: §3, this doc
- Endpoint Protection: §11, §12
- Vulnerability Management: §14
- Incident Management: §16
- Risk Management: §3
- Network Protection: §7
- Privacy Practices: Module 39, this doc §8

### 20.4 NIST Cybersecurity Framework

- **Identify:** §3 Threat Model, vendor management §18
- **Protect:** §4-§12 controls
- **Detect:** §13 Audit, §15 anomaly detection
- **Respond:** §16 Incident Response, DR_BCP §10
- **Recover:** DR_BCP §6-§7

-----

## 21. Document Maintenance

### 21.1 Review Schedule

|Section                     |Frequency                                                         |
|----------------------------|------------------------------------------------------------------|
|§3 Threat Model             |Quarterly                                                         |
|§4 Cryptographic Standards  |Annually + on standards revisions (NIST, etc.)                    |
|§5-§9 Application controls  |On significant arch change; otherwise annually                    |
|§10-§11 Infrastructure      |Annually + on infrastructure change                               |
|§12 Mobile                  |On Capacitor/iOS/Android major version changes; otherwise annually|
|§14 Vulnerability Management|Quarterly                                                         |
|§15-§16 Testing/IR          |Post-incident; otherwise annually                                 |
|§20 Compliance Mappings     |On regulation change; otherwise annually                          |

### 21.2 Update Triggers

- New module added → threat model + per-module summary updated
- New vendor → vendor management § + integrations doc updated
- Incident response findings → relevant control updated
- Regulation change → compliance mapping updated
- Penetration test findings → relevant control updated

### 21.3 Sign-off Trail

|Version|Date      |Reviewer|Notes                                             |
|-------|----------|--------|--------------------------------------------------|
|v0.1   |2026-06-08|Fabrice |Initial document spanning Phase 1 security posture|

-----

## Appendix A — Quick Reference

### A.1 Security Contact

`security@wardenx.app` (PGP key published)

### A.2 Incident Severity Quick Reference

|Type                                             |Severity                           |
|-------------------------------------------------|-----------------------------------|
|Confirmed PHI exposure                           |SEV-1                              |
|Suspected unauthorized PHI access                |SEV-1                              |
|Confirmed account takeover (single user)         |SEV-2                              |
|Account takeover affecting many                  |SEV-1                              |
|Critical CVE in production code, unpatched       |SEV-2 (until patched)              |
|High CVE same                                    |SEV-3                              |
|Vendor security incident, PHI implications       |SEV-1                              |
|Vendor security incident, no PHI implications    |SEV-3                              |
|Suspected insider threat                         |SEV-1                              |
|Unauthorized cross-tenant access attempt detected|SEV-2 to SEV-1 depending on success|
|Audit log discrepancy / tampering suspected      |SEV-1                              |

### A.3 Things That Always Require Security Owner Approval

- Change to authentication mechanism
- Change to authorization model
- Change to cryptographic standard
- Adding new vendor with PHI access
- Granting platform_ops role to a new individual
- Using break-glass credential
- Disabling a security control even temporarily

-----

## Appendix B — Glossary

|Term        |Definition                                                                                                                |
|------------|--------------------------------------------------------------------------------------------------------------------------|
|**STRIDE**  |Threat classification: Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege|
|**PHI**     |Protected Health Information (HIPAA)                                                                                      |
|**BAA**     |Business Associate Agreement (HIPAA)                                                                                      |
|**RLS**     |Row-Level Security (PostgreSQL)                                                                                           |
|**RBAC**    |Role-Based Access Control                                                                                                 |
|**ABAC**    |Attribute-Based Access Control                                                                                            |
|**IDOR**    |Insecure Direct Object Reference                                                                                          |
|**SAST**    |Static Application Security Testing                                                                                       |
|**DAST**    |Dynamic Application Security Testing                                                                                      |
|**SCA**     |Software Composition Analysis                                                                                             |
|**SBOM**    |Software Bill of Materials                                                                                                |
|**CIS**     |Center for Internet Security                                                                                              |
|**CSP**     |Content Security Policy                                                                                                   |
|**HSTS**    |HTTP Strict Transport Security                                                                                            |
|**mTLS**    |Mutual TLS (both parties authenticate)                                                                                    |
|**CSPRNG**  |Cryptographically Secure Pseudo-Random Number Generator                                                                   |
|**CVE**     |Common Vulnerabilities and Exposures                                                                                      |
|**CVSS**    |Common Vulnerability Scoring System                                                                                       |
|**KEV**     |Known Exploited Vulnerabilities (CISA catalog)                                                                            |
|**EDR**     |Endpoint Detection and Response                                                                                           |
|**MDM**     |Mobile Device Management                                                                                                  |
|**HSM**     |Hardware Security Module                                                                                                  |
|**KMS**     |Key Management Service                                                                                                    |
|**TOTP**    |Time-based One-Time Password (RFC 6238)                                                                                   |
|**WebAuthn**|Web Authentication API (FIDO2)                                                                                            |

-----

**End of WARDENX_SECURITY_HARDENING v0.1.**