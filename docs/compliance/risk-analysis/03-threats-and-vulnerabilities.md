# 03 — Threats and vulnerabilities

Part of the [risk analysis pack](./README.md) for CW-RA-01. **Draft: unreviewed, unsigned.**

Threats come from the STRIDE model in `docs/architecture/CHARTWARDEN_SECURITY_HARDENING_v0_2.md` (§3.2 platform threats,
§3.4 per-module summary, §3.5–§3.7) and from the register. Vulnerabilities come from the open rows of
[`compliance/controls.yaml`](../../../compliance/controls.yaml) (status at commit `0937b5eb1`) and from the places the
architecture documents themselves say a control is target or not built. **A vulnerability here is a recorded weakness, not a
confirmed exploit.** Nothing was tested for this pack.

Row ids that start `CW-` are register rows; their status (`implemented`, `partial`, `gap`) is the register's and is not
restated here except where the status is the point. For what each row proves and its owner and `review_by`, read the row.

STRIDE letters: **S**poofing, **T**ampering, **R**epudiation, **I**nformation disclosure, **D**enial of service, **E**levation of privilege.

## 1. Threats

| ID | Threat | STRIDE | Assets | Controls and decisions | Source |
|---|---|---|---|---|---|
| T-01 | A user, process or credential of one tenant reaches another tenant's PHI | I E | A-01..A-06, A-24 | CW-AC-01, CW-AC-02, CW-AC-16; ADR-0010, ADR-0011 | Hardening §3.2.1 |
| T-02 | Audit events are altered, deleted or never written | T R | A-07 | CW-AU-01 | §3.2.2 |
| T-03 | A legitimate account is taken over (phishing, stuffing, session theft) | S | A-09, A-01 | CW-IA-01, CW-AC-04, CW-AC-02A, CW-AC-45 | §3.2.3 |
| T-04 | A user gains authority they were not given: missing check, IDOR, role self-assignment, predicate manipulation | E | A-01..A-06 | CW-AC-02, CW-AC-11, CW-AC-44, CW-AC-53; ADR-0090 | §3.2.4 |
| T-05 | PHI reaches logs, error text, URLs, telemetry or a vendor that should not have it | I | A-14, A-13, P-01..P-08 | CW-AC-37, CW-AC-06, CW-AC-11, CW-AI-01, CW-BA-01 | §3.2.5; `deploy/production/README.md` |
| T-06 | A platform operator or tenant insider misuses legitimate access | E I T | A-40, A-41, A-16, A-01 | CW-AC-40, CW-AC-45, CW-AC-03, CW-AC-12, CW-AC-13, CW-AC-22; ADR-0112 | §3.2.6, §22.1 |
| T-07 | A dependency, base image, build tool or vendor is compromised | T I | A-15, A-35 | CW-VM-01, CW-CM-01, CW-MAL-01 | §3.2.7 |
| T-08 | The service is unavailable: application DoS, network flood, resource exhaustion, host failure | D | A-22..A-26 | CW-CP-01, CW-IA-01 (credential throttle) | §3.2.8 |
| T-09 | AI features: prompt injection, PHI sent to a model, wrong output acted on | I T R | A-13 | CW-AI-01; ADR-0012, ADR-0114 | §3.2.9; AI Governance |
| T-10 | Inbound data is forged or mistaken: webhooks, ADT, lab results, remittances | S T | A-05, A-01, A-30 | CW-TX-02, CW-TX-03, CW-TX-04, CW-AC-10, CW-AC-25 | §3.4 (M29 row), §3.5 |
| T-11 | A clinical record is altered or signed without authority or without the required act | T R S | A-01 | CW-AC-46, CW-AC-47..52, CW-AC-54, CW-AU-01 | §3.4 (M8 row) |
| T-12 | A false, duplicate or unauthorized claim is sent or posted | T R E | A-05 | CW-AC-24, CW-AC-18, CW-AC-36, CW-PI-01..06, CW-AC-20; ADR-0100, ADR-0053 | §3.4 (M23), §3.6 |
| T-13 | An e-prescription is sent twice, lost or recorded wrongly; prescribing fraud | T S | A-01, A-08 | CW-AC-21, CW-AC-23; ADR-0111, ADR-0019 | §3.4 (M12 row) |
| T-14 | A patient or family member is impersonated, or a proxy sees or signs beyond their grant | S I | A-42, A-01 | CW-AC-09, CW-IA-01; ADR-0107 (Proposed) | §3.4 (M31 row) |
| T-15 | Part 2 or other PHI-Sensitive content is disclosed without the consent or the role the law needs | E I | A-02 | CW-AC-43, CW-AC-51, CW-AC-55; ADR-0014, ADR-0115 | §3.4 (M39 row), §3.8 |
| T-16 | Data at rest is read from a host, a volume, a backup or a key store | I | A-04, A-10, A-11, A-12, A-25, A-26 | CW-AC-05, CW-DS-01, CW-CP-01; ADR-0038, ADR-0045 | §4.2, §22.1 |
| T-17 | Traffic is intercepted or downgraded on a hop | I T | A-20, A-25, A-26 | CW-TX-01 | §4.3 |
| T-18 | A secret or credential is exposed through the repo, CI or a config file | I E | A-10, A-34, A-35 | CW-SEC-01, CW-SEC-02, CW-AC-17, CW-AC-21 | §4.5 |
| T-19 | An unsafe change (migration, image, config) reaches production | T D | A-24, A-35 | CW-CM-01 | CW-CM-01 |
| T-20 | An AI coding agent or a workstation exposes PHI or secrets, or changes controls unreviewed | I | A-36, A-15 | CW-CM-02 | `docs/compliance/AGENT_HARNESS.md` |
| T-21 | PHI flows to a vendor with no executed BAA, or after the BAA ended | I | P-01..P-08 | CW-BA-01, CW-AC-14, CW-AC-17, CW-AC-22 | §3.2.5 (BAA inventory) |
| T-22 | Misuse or an incident goes unnoticed, or is handled without rehearsal | R I | A-07, A-01 | CW-MON-01, CW-IR-01, CW-AU-01 | §3.2.6 (anomaly detection) |
| T-23 | Data is lost and cannot be restored within the targets | D T | A-11, A-24, A-26 | CW-CP-01 | DR/BCP §3, §4.8 |
| T-24 | Data is kept past its retention, or destroyed data survives in a copy | I | A-04, A-11, A-12 | CW-DS-01, CW-BR-06, CW-BR-09, CW-BR-10, CW-BR-14; ADR-0051 | §8.2.4 |
| T-25 | A critical lab result is not actioned by a person | D I | A-06, A-01 | CW-CS-01 | CW-CS-01 |
| T-26 | A single person holds every security role, so decisions and risk acceptance go unchecked, and their loss stops the program | R D | A-44 | CW-RA-01 | Hardening §2.1; AI Governance §3.2 |
| T-27 | A malicious file is uploaded or attached and executes, spreads or is served to a user | T I | A-04, A-27 | CW-MAL-01 | CW-MAL-01 |
| T-28 | A client device or its lock screen shows PHI to someone not entitled | I | A-37 | CW-AC-04; ADR-0074 | §8.2.5 (push and lock-screen rules) |

## 2. Vulnerabilities

"Not in the register" marks a weakness the architecture documents or the compose file record and no register row covers.

| ID | Vulnerability | Evidence | Threats |
|---|---|---|---|
| V-01 | The `platform_ops` role holds data entry, BAA upload, register write, go-live approval and pricing together; the platform hostname is reachable by anyone who can reach it (no IP allowlist or mTLS), with only nginx per-address request and connection limits, on the BAA-upload route, ahead of the request body | CW-AC-22 `partial` | T-06, T-04 |
| V-02 | `administrator` and `org_admin` read every patient in the organization, and the shared rule also waives the caseload check on mutating routes; read-audit rows do not record that org-wide scope admitted the read | ADR-0090; Hardening §3.8 (an accepted decision, not a gap row) | T-04, T-06 |
| V-03 | The passkey requirement for privileged roles is enforced only when `CHARTWARDEN_MFA_ENFORCEMENT=true` (opt-in in code); production has no `superadmin` holder, so the passkey sign-in and support-session start are not yet proven | CW-AC-45 `partial`; CW-AC-55 | T-03, T-06 |
| V-04 | Break-glass opens a chart on 2 of the 8 workflow stages; the other 6 refuse. It fails closed: an availability gap during an emergency, not a PHI exposure | CW-AC-03 `partial` | T-06, T-08 |
| V-05 | Internal callers authenticate with one static shared secret (`INTERNAL_SERVICE_TOKEN`); the tenant is named by a caller-supplied `x-internal-org-id` header. No mTLS, no signature, no expiry, no per-request binding, no automatic rotation. **Not in the register** | Hardening §6.5 ("TARGET — NOT BUILT"); `apps/backend/src/bootstrap/plugins/authenticate.ts`; `scripts/check-request-header-auth.ts` | T-01, T-04, T-18 |
| V-06 | Four encryption keys are held in the application environment, not an HSM (ADR-0045 Decision 1): `M34_TENANT_KEK` wraps every tenant's DEK, and `M24_CREDENTIAL_ENCRYPTION_KEY`, `MESSAGING_ENCRYPTION_KEY` and `TWO_FACTOR_ENCRYPTION_KEY` each protect their own data. A compromise of the process or of `.env.production` reaches them. **No register row assesses where they are held** | ADR-0045; Hardening §22.1 | T-16, T-18, T-01 |
| V-07 | Document objects are plaintext in the object store (and in the planned RustFS copy); at-rest protection rests on host disk encryption, which no gate checks on either host. Generated exports are plaintext too | CW-AC-05 `partial`; Hardening §4.2, §8.5 | T-16 |
| V-08 | A plaintext copy of every document remains in the retired MinIO volume on a host that went through the SeaweedFS cutover and has not removed it: outside backups, outside compose, outside preflight beyond a warning | CW-AC-05 `partial`, CW-DS-01 `partial` | T-16, T-24 |
| V-09 | A shred does not reach a second copy (the replica, not enabled in production, runs hourly and a `--restore` brings destroyed objects back); bereavement mailing batch PDFs have no purge path | CW-DS-01 `partial`; CW-BR-10 `partial` | T-24 |
| V-10 | TLS on the edge and internal hops is documented but not asserted by any gate; the object store is reached over plain HTTP on the Compose network; the replica's TLS and firewall are manual steps | CW-TX-01 `partial`; Hardening §4.3 | T-17 |
| V-11 | Nothing reviews audit events: no detections for brute force, impossible travel, mass export or break-glass use, and no alert routing | CW-MON-01 `gap` | T-22, T-06, T-02 |
| V-12 | No tabletop or incident-drill record shows the written procedures were exercised | CW-IR-01 `partial` | T-22 |
| V-13 | No streaming replica; WAL archiving is an owner statement with no repository evidence; no scheduled whole-database drill with recorded RTO and RPO; drills ran at synthetic scale on a developer machine; reindex time on production data is unmeasured | CW-CP-01 `partial`; DR/BCP §4.8.3 | T-23, T-08 |
| V-14 | No static analysis runs on the TypeScript source | CW-VM-01 `partial` | T-07, T-19 |
| V-15 | `main` has no branch protection and the `production` Environment has no required reviewers: the ruleset (`.github/rulesets/main.json`) and the PR gate (`pr-gate.yml`) are defined in the repository but not applied or yet run on GitHub, and with one code owner and an admin pull-request bypass review is not independent even once applied; the migration classifier is a heuristic (a `contract` migration falsely declared `expand` still auto-applies); a held migration blocks every push to main, a security fix included. **Full CI is waived on the deploy path**: `.github/workflows/deploy.yml` has `verify` commented out ("ci-waived until 2026-11-29", an owner decision recorded there as 2026-10-30), so `release` needs only `debounce` and `quality` (typecheck and lint). While that stands, the live suites that prove the NOBYPASSRLS cross-tenant boundary are not a deploy precondition | CW-CM-01 `partial`; CW-SEC-01; `deploy.yml` | T-19, T-07, T-18 |
| V-16 | Secret and PHI scanning is not yet a required check: the pre-commit hook now fails closed and its install is enforced locally, but the PR-gate scan is not required until the ruleset is applied (V-15); `--no-verify` and `GITHUB_ACTIONS=true` remain deliberate local bypasses; the server-side PHI scan reads a PR's final tree, gitleaks has no SSN rule, and `generic-api-key` is disabled, so the scan is not proof that no secret is present | CW-SEC-01 `partial` | T-18 |
| V-17 | The agent PreToolUse guard is shell-text heuristics for a cooperative agent, not a sandbox; the local ledger is an unkeyed hash chain that catches accidents, not tampering | CW-CM-02 `partial` | T-20 |
| V-18 | BAA status is prose, with no machine-checked vendor register of date and scope per vendor; several integrations read "TBD" until production; a tenant-held BAA verification is a point in time and nothing ends it when the vendor does | CW-BA-01 `partial`; CW-AC-14, CW-AC-17 `partial`; Integrations §5 | T-21, T-05, T-09 |
| V-19 | Valkey starts as `valkey-server --appendonly yes`: no `requirepass`, no TLS in the compose file (Hardening §4.3 shows both as the design); it persists to a volume. Per code comments production binds the RBAC permission cache, credential-throttle limiter keys and auditor one-time link tokens to it, so anything that can reach the port could read or poison them (runtime bindings not inspected; whether job payloads carry PHI was not verified). **No register row assesses it** | `deploy/production/compose.yml`; `packages/auth/src/rbac/cache.ts`; `packages/auth/src/identity/credential-throttle.ts`, `auditor-session.ts` | T-16, T-17, T-04, T-03 |
| V-20 | The Bun-to-Rust bridge's enforcement (signature verification, replay rejection, READ ONLY transactions) is proven only in `chartwarden-rust`; the signing-key secret is not yet in `compose.yml`; merged off | CW-AC-07 `partial`; Hardening §3.7 | T-01, T-03 |
| V-21 | Integrity guards are triggers that the table owner or a superuser can disable, and row triggers do not fire on TRUNCATE; the `chartwarden_destruction` role also holds SELECT and DELETE on `audit_event` (a carve-out; the role is NOLOGIN, but `chartwarden_destruction_login` inherits it and its URL is in the `api`, `worker` and `hl7-listener` environments), and the integrity report inspects `chartwarden_app` only. **No register row assesses the carve-out or the report's blind spot**; the trigger limits are recorded in CW-PI-06 and CW-AC-01 | CW-PI-06 `partial`; CW-AC-01 evidence note on WF09; Hardening §13.1 | T-02, T-11, T-12, T-01 |
| V-22 | The platform carrier reaches the central Claim.MD tables through membership of `claimmd_capture`, which holds table-wide SELECT on `claimmd_era_m25_stage` (including its sealed cipher column) with a `USING (true)` policy; no live test proves the platform-role boundary beyond the membership | CW-AC-10 `partial` | T-01, T-10, T-12 |
| V-23 | Claims-billing enforcement is the code default, but the repository cannot show that production runs it (a deployment that pins `shadow` with a written reason only logs and records a refusal until an operator flips it, ops runbook 8.7); an incomplete `CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS` list halts other tenants' claims at once | CW-AC-24 `partial` | T-12 |
| V-24 | The Idempotency-Key release rule cannot prove what it cannot see: a context lost inside a handler can be released and still commit, and an effect outside Postgres (an outbound call, a queue write) made by a route that answered 5xx while its handler keeps running is neither counted nor fenced (its later Postgres writes are refused once the key is released); the refusal itself can end a process when an abandoned async chain around a refused write nobody awaits has no `.catch`, and reaches every request that awaits shared work started under the fenced request (none exists today; a convention, not a gate) | CW-AC-36 `partial` | T-12, T-11 |
| V-25 | HOPE signing does not require the signer to be the author; the signer's licence is not checked at signing; `attestationVersion` is optional | CW-AC-46 `partial` | T-11 |
| V-26 | Visit-note controls: closure-gate refusals are a throttled log line and a counter, not an audit event; a DON or administrator can change the closure policy or the draft switch with step-up and a warn-severity audit event but no second person and no alert; chained override grants are visible only to an audit reader; M22 has no Part 2 document path, so a signed note shows markers; a wound can be created for a patient uuid that does not exist in the organization | CW-AC-47, CW-AC-48, CW-AC-49, CW-AC-50, CW-AC-51, CW-AC-52, CW-AC-54 `partial` | T-11, T-15 |
| V-27 | DoseSpot vendor facts (token endpoint, field names, whether the Subscription-Key is per clinic) are unverified until a sandbox run; resolution of a held prescription is an administrator's attestation that can be mistyped or read from a draft | CW-AC-21, CW-AC-23 `partial` | T-13 |
| V-28 | A tenant administrator reads Part 2 content through the ADR-0115 exception; two tenant routes set no `failClosed`, so a failed read-audit write still returns the pages; the MFA requirement behind the exception is opt-in in code | CW-AC-55 `partial`; CW-AC-45 | T-15, T-03 |
| V-29 | A quarantined critical result is paged and escalated once, but the queue has no resolve or acknowledge path: the control proves delivery, not resolution | CW-CS-01 `partial` | T-25 |
| V-30 | The Claim.MD webhook scheme is proven against our own signed fixtures only (ingress stays off until a real delivery is captured); the Episode Alert adapters stay fail-closed with no verified wire | CW-TX-02, CW-TX-04 `partial` | T-10 |
| V-31 | Portal admission-document signing: the control is proven on a real database as `chartwarden_app`; the row's gap text records the residuals it does not close | CW-AC-09 `partial` | T-14 |
| V-32 | Billing integrity residuals: the 835 intake is proven on synthetic files only, and a quarantined file is released or dismissed by admin SQL; SIA defaults await compliance sign-off; pre-fix visits with illegal discipline pairs are not remediated; the refusal of a transfer notice for an outside tenant is proven only by a non-live test; the pricing guards are triggers (V-21) | CW-PI-03, CW-PI-04, CW-PI-05, CW-AC-20, CW-PI-06 `partial` | T-12 |
| V-33 | Minimum-necessary reads: the census age and the audit actor names are proven live as the NOBYPASSRLS role, but the patient write-audit trigger (migration 0021) scrubs only the legal-name columns, so `audit_event.before`/`after` hold `dob`, `mrn` and the other demographic columns at rest, archived partitions included (the audit API now censors `dob` through the field denylist, which matches exact lower-case key names, so `mrn` and the snake_case columns still return); a routine read of the log is not itself audited | CW-AC-06 `partial` | T-05, T-04 |
| V-34 | One interim owner holds the Security Owner, Compliance Officer, Vulnerability Manager and Incident Responder roles; no penetration tester is engaged ("None yet"); there is no independent reviewer for risk acceptance. **Not in the register** | Hardening §2.1; AI Governance §3.2 | T-26, T-22 |
| V-35 | One host runs the application, database, object store, scanner and backup sidecar: a failure or compromise of the host reaches all of them. The multi-VM design is target | `deploy/production/compose.yml` header; DR/BCP §4.8; CW-CP-01 | T-08, T-23, T-16 |
| V-36 | The object-store access audit stream is best-effort: an audit gap is accepted for it, and a down Fluent Bit never blocks a request | Compose comment (GAP-141); CW-AU-01 | T-02, T-22 |
| V-37 | The `api`, `worker` and `hl7-listener` environments carry a `LOGIN BYPASSRLS` platform login (`DATABASE_PLATFORM_URL`: cross-tenant admin reads and writes, platform-context enumerators, the org-offboarding eraser) and an org-scoped destruction login (`DATABASE_DESTRUCTION_URL`). Tenant isolation on the request path rests on code using the right pool; a defect that reaches the platform pool, or a compromise of those processes, is not bounded by RLS. CW-AC-01 proves the NOBYPASSRLS role; **no register row assesses the platform-pool boundary** | `deploy/production/compose.yml` (api, worker, hl7-listener); `scripts/db/provision-runtime-roles.ts` header | T-01, T-06, T-02 |

## 3. Coverage

Every register row is cited by at least one risk in file 04; file 04 §4 holds the check for that. Every threat, vulnerability
and asset in this directory is also cited by at least one risk or roll-up row, which was checked by hand at the base commit
and is not scripted. A register row cited by a risk is *considered*; it is not thereby shown to work. Rows the register marks
`implemented` appear on risks as the controls those risks lean on.
