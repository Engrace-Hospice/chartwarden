# 04 — Residual-risk register

Part of the [risk analysis pack](./README.md) for CW-RA-01. **Draft: unreviewed, unsigned.**

**Every likelihood, impact, score, treatment, owner, date and status cell in §2 and §3 is blank on purpose.** Those are the
accountable owner's decisions (file 02 §8). §1 holds only what the repository evidences. Status labels are
`compliance/controls.yaml` at commit `0937b5eb1`: `impl` is `implemented`, `part` is `partial`, `gap` is `gap`.

A cited control is not shown to work by being cited. Where a risk's control evidence is an owner statement, or where no
register row covers the weakness, the note says so and §2 shows no control credit.

## 1. Risks: what the repository records

| ID | Risk | Assets | Threats | Vulnerabilities | Controls (status) and ADRs | Notes |
|---|---|---|---|---|---|---|
| R-01 | Cross-tenant PHI exposure through a path that bypasses RLS or the tenant binding | A-01, A-02, A-03, A-04, A-05, A-06, A-22, A-23, A-24, A-31 | T-01 | V-20, V-21, V-22, V-37 | CW-AC-01 (impl), CW-AC-02 (impl), CW-AC-16 (impl), CW-AC-10 (part), CW-AC-07 (part); ADR-0010; ADR-0011 | RLS is proven live as the NOBYPASSRLS role (CW-AC-01). V-20 to V-22 are the recorded exceptions to the guard model. V-37: the `api`, `worker` and `hl7-listener` environments also hold a BYPASSRLS platform login, and while full CI is waived on the deploy path (V-15) the live suites behind CW-AC-01 are not a deploy precondition. |
| R-02 | The shared system credential is used, or leaked, to act as any tenant | A-22, A-23, A-01, A-05 | T-01, T-04, T-18 | V-05 | CW-AC-02 (impl) | No register row covers the shared-secret model. CW-AC-02 is cited only for `arch:request-header-auth`, which classifies the header read. Hardening §6.5 calls the design target, not built. |
| R-03 | Takeover of a clinical or administrative account | A-09, A-01 | T-03 | V-03 | CW-IA-01 (impl), CW-AC-04 (impl), CW-AC-02A (impl), CW-AC-45 (part) | The passkey requirement for privileged roles is opt-in in code; the register records it found on in production on 2026-11-25 (verified in the running api container; browser checks are operator-reported, platform account only). |
| R-04 | Misuse or compromise of a platform operator or `superadmin` account | A-40, A-16, A-01 | T-06, T-03 | V-01, V-03, V-04 | CW-AC-40 (impl), CW-AC-45 (part), CW-AC-22 (part), CW-AC-12 (impl), CW-AC-13 (impl), CW-AC-15 (impl), CW-AC-41 (impl), CW-AC-42 (impl), CW-AC-03 (part); ADR-0112 | No `superadmin` holder exists in production. The consent-bound support session is proven live (CW-AC-40). |
| R-05 | Over-broad tenant access through org-wide scope and role defaults | A-41, A-01 | T-04, T-06 | V-02, V-33 | CW-AC-44 (impl), CW-AC-53 (impl), CW-AC-06 (part), CW-AC-02 (impl); ADR-0090 | ADR-0090 is an accepted product decision that widened access. The owner may record it as an accepted risk with a rationale. |
| R-06 | Plaintext documents read from a host, a volume or a stale copy | A-04, A-12, A-11, A-26 | T-16 | V-07, V-08, V-35 | CW-AC-05 (part), CW-DS-01 (part), CW-CP-01 (part); ADR-0038 | Host disk encryption is the control the row leans on, and no gate checks it on either host. |
| R-07 | Compromise of the application process or `.env.production` exposes the env-held encryption keys, so the data they protect | A-10, A-22, A-34 | T-16, T-18, T-01 | V-06 | CW-AC-17 (part), CW-AC-21 (part); ADR-0045; ADR-0038; ADR-0034 | No register row assesses where the keys are held. `M34_TENANT_KEK` wraps every tenant's DEK (CW-AC-21 seals under the DEK); CW-AC-17's key is derived from `M24_CREDENTIAL_ENCRYPTION_KEY`; TOTP secrets sit under `TWO_FACTOR_ENCRYPTION_KEY`. |
| R-08 | An unauthenticated or unencrypted internal hop (Valkey, object store over HTTP) is read or altered, or edge TLS is weaker than documented | A-20, A-21, A-25, A-26 | T-17, T-16, T-04, T-03 | V-10, V-19 | CW-TX-01 (part), CW-AC-01 (impl) | TLS posture is not asserted by any gate. No register row assesses V-19; if the Valkey bindings in file 01 A-25 hold, a write to Valkey could poison the permission cache. |
| R-09 | Misuse of PHI goes undetected because nothing reviews audit events | A-07, A-01 | T-22, T-06 | V-11, V-36 | CW-MON-01 (gap), CW-AU-01 (impl) | Audit events are recorded; nothing reviews them. `docs/compliance/AISOC_INTEGRATION.md` is a plan. |
| R-10 | The audit trail is altered, deleted or silently not written | A-07, A-29 | T-02 | V-21, V-36 | CW-AU-01 (impl) | The hash-chain seal is flag-gated and inert (`packages/audit/src/integrity/index.ts`). The quarterly sample-versus-backup job was not verified as scheduled in production. The destruction login that can DELETE from `audit_event` is in the `api`, `worker` and `hl7-listener` environments (V-21). |
| R-11 | An incident is mishandled because the procedures were never rehearsed | A-01, A-07 | T-22 | V-12 | CW-IR-01 (part) | Procedures are written (DR/BCP, Ops Runbook). No exercise record exists. |
| R-12 | Loss of the database or objects, or a restore that misses the targets | A-11, A-24, A-26, A-33 | T-23 | V-13, V-35 | CW-CP-01 (part) | Owner statement: the backup sidecar and WAL archiving run in production, with no repository evidence. The method gives it no credit. |
| R-13 | Outage of Tier 1 services from DoS, resource exhaustion or loss of the single host | A-22, A-24, A-25 | T-08 | V-35, V-13, V-04 | CW-CP-01 (part), CW-IA-01 (impl) | Hardening §3.2.8 lists edge protection, per-route limits and quotas; no register row proves them beyond credential throttling (CW-IA-01). |
| R-14 | A vulnerable or malicious dependency, image or build tool reaches production | A-15, A-35 | T-07, T-19 | V-14, V-15 | CW-VM-01 (part), CW-CM-01 (part), CW-MAL-01 (impl) | SBOM, image signing and scanning are cited by the register rows; no SAST runs. Full CI is waived on the deploy path until 2026-11-29 (V-15), so `release` needs only typecheck and lint. |
| R-15 | A secret is exposed through the repository, CI or the env file | A-34, A-35, A-10, A-32 | T-18 | V-16, V-15 | CW-SEC-01 (part), CW-SEC-02 (impl) | `.env.production` reaches seven containers (compose comment). The PR-gate scan is defined but not a required check until the `main` ruleset is applied (CW-SEC-01, CW-CM-01). |
| R-16 | An unsafe migration or deploy causes an outage or an integrity loss | A-24, A-35, A-32 | T-19 | V-15 | CW-CM-01 (part) | `deploy.sh` restores the previous release only over migrations that pass `arch:migration-compat`. Full CI is waived on the deploy path until 2026-11-29 (V-15): the live suites are not a deploy precondition while that stands. |
| R-17 | An AI coding agent or a workstation leaks PHI or secrets, or alters a control unreviewed | A-36, A-15 | T-20 | V-17 | CW-CM-02 (part), CW-SEC-01 (part) | The guard is for a cooperative agent, not a sandbox. |
| R-18 | PHI reaches a vendor with no executed BAA, or after the BAA ended | A-04, A-05, A-13 | T-21, T-05 | V-18 | CW-BA-01 (part), CW-AC-14 (part), CW-AC-17 (part), CW-AC-22 (part), CW-DD-01 (impl); ADR-0020 | Integrations §5 reads TBD for several vendors. Executed BAA copies are not held in the repository. |
| R-19 | The cloud AI path leaks PHI, or its output is acted on wrongly | A-13, A-28 | T-09 | V-18 | CW-AI-01 (impl), CW-BA-01 (part); ADR-0012; ADR-0114 | The cloud path stays disabled until `external.anthropic_baa_executed` is set (ADR-0012). |
| R-20 | Forged or mistaken inbound vendor data is accepted (webhook, ADT, lab, remittance) | A-05, A-01, A-30 | T-10 | V-30, V-22 | CW-TX-02 (part), CW-TX-03 (impl), CW-TX-04 (part), CW-AC-10 (part), CW-AC-25 (impl), CW-AC-05B (impl) | Claim.MD ingress is off until a real delivery is captured; Episode Alert is fail-closed. |
| R-21 | A clinical record is altered or signed without proper authority or the required act | A-01 | T-11 | V-25, V-26, V-21, V-24 | CW-AC-46 (part), CW-AC-47 (part), CW-AC-48 (part), CW-AC-49 (part), CW-AC-50 (part), CW-AC-51 (part), CW-AC-52 (part), CW-AC-54 (part), CW-AU-01 (impl); ADR-0113; ADR-0114 | Most residuals here are owned by the clinical platform team with `review_by` in 2027-04. |
| R-22 | A wrong, duplicate or unauthorized claim is sent or posted | A-05 | T-12 | V-23, V-24, V-32, V-22, V-21 | CW-AC-24 (part), CW-AC-18 (impl), CW-AC-36 (part), CW-AC-20 (part), CW-PI-01 (impl), CW-PI-02 (impl), CW-PI-03 (part), CW-PI-04 (part), CW-PI-05 (part), CW-PI-06 (part); ADR-0100; ADR-0053 | Enforcement of the tenant-clearinghouse rule is the code default, but the repository cannot show that production runs it (CW-AC-24). |
| R-23 | An e-prescription is sent twice, lost or recorded wrongly | A-01, A-08 | T-13 | V-27 | CW-AC-21 (part), CW-AC-23 (part); ADR-0111; ADR-0019 | EPCS is deferred (ADR-0019); DoseSpot is unbound until a tenant registration is `active`. |
| R-24 | The wrong person signs or views through the portal | A-42, A-01 | T-14 | V-31 | CW-AC-09 (part), CW-IA-01 (impl); ADR-0107 (Proposed) | See the CW-AC-09 gap text for the residuals. |
| R-25 | Part 2 content is disclosed without the consent or the role the law needs | A-02 | T-15 | V-28, V-26 | CW-AC-43 (impl), CW-AC-51 (part), CW-AC-55 (part), CW-AC-45 (part); ADR-0014; ADR-0115 | ADR-0115 is an explicit minimum-necessary exception for intake review, not a disclosure authorization. |
| R-26 | Data is kept past retention, or destroyed data survives in a copy | A-04, A-11, A-12 | T-24 | V-09, V-08 | CW-DS-01 (part), CW-BR-06 (impl), CW-BR-09 (impl), CW-BR-10 (part), CW-BR-14 (impl); ADR-0051 | A pre-shred snapshot still holds a destroyed key until it ages out (Hardening §22.1). |
| R-27 | A critical lab result sits in quarantine with no one resolving it | A-06, A-01 | T-25 | V-29 | CW-CS-01 (part) | The row proves delivery of the page, not resolution. |
| R-28 | One person holds every security role, so risk acceptance goes unchecked and their loss stops the program | A-44 | T-26 | V-34 | CW-RA-01 (part) | Roles only; this pack names no person. Whether an independent reviewer exists is decision D8 in file 02. |
| R-29 | PHI reaches logs, error text or telemetry, or a list read returns more than the minimum necessary | A-14, A-03 | T-05 | V-33 | CW-AC-37 (impl), CW-AC-06 (part), CW-AC-11 (impl), CW-AC-35 (impl) | Nginx access logs record the path only (`chartwarden_phi_safe`), but `error_log` can still echo the request line with its query string and must be treated as PHI-bearing; the host's nginx include order is a manual check (`deploy/production/README.md`, "Nginx logging (PHI)"). |
| R-30 | Malware in an upload or attachment reaches storage or users | A-04, A-27 | T-27 | none recorded | CW-MAL-01 (impl) | No open vulnerability is recorded and the cited row reads `implemented`; included so the owner sees a risk with no recorded gap beside the open ones. |
| R-31 | A lost or shared client device, or a lock screen, shows PHI | A-37 | T-28 | none recorded | CW-AC-04 (impl); ADR-0074 | ADR-0074's generic lock-screen wording is provisional with no clinical-lead sign-off (Hardening §3.8). |
| R-32 | An external auditor reads before the BAA is accepted and a second factor is proven | A-43, A-01 | T-04 | none recorded | CW-AU-02 (impl), CW-AC-19 (impl) | No open vulnerability is recorded. |
| R-33 | A bereavement mailing, roster, invitation or letter reaches someone the family did not want, or names a family it should not | A-01, A-04 | T-05, T-24 | V-09 | CW-BR-01 (impl), CW-BR-02 (impl), CW-BR-03 (impl), CW-BR-04 (impl), CW-BR-05 (impl), CW-BR-07 (impl), CW-BR-08 (impl), CW-BR-11 (impl), CW-BR-12 (impl), CW-BR-13 (impl), CW-BR-10 (part); ADR-0109 | ADR-0109 is Proposed; the register rows carry the proof. The rendered batch PDFs have no purge path (CW-BR-10). |

## 2. Scoring sheet (owner completes)

Columns follow file 02: inherent likelihood (L), impact (I) and score (L × I); residual L, I and score; treatment
(mitigate, accept, transfer, avoid); owner role; target date; status. **Max L drop** is the only filled column and is an
engineering proposal (decision D3): the control-credit cap of file 02 §4 computed from the cited rows' status at the base
commit, tightened to 0 where no register row covers a named weakness or the evidence is an owner statement. The owner may
override it with a written reason. It is a limit on how far residual L may fall below inherent L, not a score.

| ID | Inh L | Inh I | Inh score | Res L | Res I | Res score | Max L drop (proposal) | Override reason | Treatment | Owner role | Target date | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R-01 |  |  |  |  |  |  | 0 (no row assesses V-37, the platform-pool boundary) |  |  |  |  |  |
| R-02 |  |  |  |  |  |  | 0 (no row covers V-05) |  |  |  |  |  |
| R-03 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-04 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-05 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-06 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-07 |  |  |  |  |  |  | 0 (no row covers V-06) |  |  |  |  |  |
| R-08 |  |  |  |  |  |  | 0 (no row covers V-19) |  |  |  |  |  |
| R-09 |  |  |  |  |  |  | 0 |  |  |  |  |  |
| R-10 |  |  |  |  |  |  | 0 (no row assesses V-21's destruction-role carve-out) |  |  |  |  |  |
| R-11 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-12 |  |  |  |  |  |  | 0 (owner statement) |  |  |  |  |  |
| R-13 |  |  |  |  |  |  | 0 (no row proves the §3.2.8 controls) |  |  |  |  |  |
| R-14 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-15 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-16 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-17 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-18 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-19 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-20 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-21 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-22 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-23 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-24 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-25 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-26 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-27 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-28 |  |  |  |  |  |  | 0 (no row covers V-34) |  |  |  |  |  |
| R-29 |  |  |  |  |  |  | 1 |  |  |  |  |  |
| R-30 |  |  |  |  |  |  | 2 |  |  |  |  |  |
| R-31 |  |  |  |  |  |  | 0 (CW-AC-04 versus Hardening §3.2.3 unreconciled, README difference 1) |  |  |  |  |  |
| R-32 |  |  |  |  |  |  | 2 |  |  |  |  |  |
| R-33 |  |  |  |  |  |  | 1 |  |  |  |  |  |

## 3. Per-asset roll-up (owner completes)

An asset's residual score is the highest residual score among the risks that name it (file 02 §5). "none yet" means no risk
row names the asset; the owner decides whether a neighbouring asset's risk covers it or a row is missing.

| Asset | Name | Risks naming it | Residual score | Notes |
|---|---|---|---|---|
| A-01 | Clinical record content | R-01, R-02, R-03, R-04, R-05, R-09, R-11, R-20, R-21, R-23, R-24, R-27, R-32, R-33 |  |  |
| A-02 | Part 2 and other PHI-Sensitive content | R-01, R-25 |  |  |
| A-03 | Patient identity and demographics | R-01, R-29 |  |  |
| A-04 | Documents and images | R-01, R-06, R-18, R-26, R-30, R-33 |  |  |
| A-05 | Billing and claims data | R-01, R-02, R-18, R-20, R-22 |  |  |
| A-06 | Messaging and alert content | R-01, R-27 |  |  |
| A-07 | Audit trail | R-09, R-10, R-11 |  |  |
| A-08 | Tenant-held credentials and vendor secrets | R-23 |  |  |
| A-09 | Authentication material | R-03 |  |  |
| A-10 | Key material | R-07, R-15 |  |  |
| A-11 | Backups | R-06, R-12, R-26 |  |  |
| A-12 | Retired MinIO volume | R-06, R-26 |  |  |
| A-13 | AI inputs and outputs | R-18, R-19 |  |  |
| A-14 | Logs and telemetry | R-29 |  |  |
| A-15 | Source, CI, release images | R-14, R-17 |  |  |
| A-16 | Platform tenant register | R-04 |  |  |
| A-20 | Host Nginx and edge | R-08 |  |  |
| A-21 | web | R-08 |  |  |
| A-22 | api | R-01, R-02, R-07, R-13 |  |  |
| A-23 | worker | R-01, R-02 |  |  |
| A-24 | postgres | R-01, R-12, R-13, R-16 |  |  |
| A-25 | valkey | R-08, R-13 |  |  |
| A-26 | seaweedfs | R-06, R-08, R-12 |  |  |
| A-27 | clamav | R-30 |  |  |
| A-28 | docling-worker | R-19 |  |  |
| A-29 | fluent-bit | R-10 |  |  |
| A-30 | hl7-listener | R-20 |  |  |
| A-31 | rust | R-01 |  |  |
| A-32 | One-shot privileged jobs | R-15, R-16 |  |  |
| A-33 | Backup sidecar | R-12 |  |  |
| A-34 | .env.production | R-07, R-15 |  |  |
| A-35 | CI/CD | R-14, R-15, R-16 |  |  |
| A-36 | Developer workstations and AI agents | R-17 |  |  |
| A-37 | Client devices | R-31 |  |  |
| A-40 | Platform operators | R-04 |  |  |
| A-41 | Tenant staff | R-05 |  |  |
| A-42 | Patients, family, proxies | R-24 |  |  |
| A-43 | External auditors | R-32 |  |  |
| A-44 | Security governance roles | R-28 |  |  |

## 4. Coverage check

Run from the repository root. It prints any register row that no risk cites; the base commit printed none.

```sh
bun -e 'const fs=require("fs");const reg=Bun.YAML.parse(fs.readFileSync("compliance/controls.yaml","utf8"));const doc=fs.readFileSync("docs/compliance/risk-analysis/04-residual-risk-register.md","utf8");const miss=reg.controls.map(c=>c.id).filter(id=>!new RegExp("\\b"+id+"\\b").test(doc));console.log(miss.length?miss.join(" "):"every register row is cited")'
```

A new register row, or a status change on a cited row, means a review of the risks that cite it (file 02 §7, step 1).
