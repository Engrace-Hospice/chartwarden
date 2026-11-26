# ChartWarden — HIPAA security risk analysis pack (CW-RA-01)

> **Status: DRAFT, prepared by engineering from repository evidence. Not reviewed, not scored, not signed.**
> Until the accountable owner reviews it, makes the scoring and treatment decisions and signs
> [`05-sign-off.md`](./05-sign-off.md), this is working material for a risk analysis, not a risk analysis.
> Nothing in it states that ChartWarden is, or will be, HIPAA compliant.

This pack is the evidence pointer for control **CW-RA-01** in [`../../../compliance/controls.yaml`](../../../compliance/controls.yaml)
(HIPAA §164.308(a)(1)(ii)(A) risk analysis and (B) risk management; SOC 2 CC3.2). The register row stays
`partial`: the pack exists, and what is missing is the owner's review, scoring, treatment decisions and signature.

It is the engineering input to the annual analysis the Ops Runbook already defines
([§12.1](../../architecture/CHARTWARDEN_OPS_RUNBOOK_v0.1.md): document review, technical review, findings, mitigation plan,
sign-off by the compliance officer and engineering, filed 6+ years). It does not replace the assessor, the site walkthrough
or the policy and training review that §12.1 lists.

## What the pack is, and is not

| It is | It is not |
|---|---|
| An asset and data-flow inventory built from `docs/architecture/`, `architecture/module-manifest.ts` and `deploy/production/` | A statement that any control works. A control's status is the register row's, read at the commit below |
| A threat and vulnerability table where every entry cites a register row (`CW-…`), an ADR, or the architecture section it came from | A penetration test, a code audit or a scan. Nothing here was executed against a running system |
| A scoring method with anchored likelihood and impact scales | A set of scores. Every likelihood, impact, treatment, owner and acceptance cell is left blank for the owner; the one prefilled column in file 04 §2 is a computed control-credit cap, labelled an engineering proposal |
| A residual-risk register that lists what the repository itself records as open | A list of every risk. It holds what the repository's own evidence can name; administrative and physical areas are listed under "Not evidenced in this repository" |
| A blank sign-off page | Signed, dated or approved by anyone |

## Scope

In scope: the stack the repository ships and deploys, a single-host Docker Compose installation
([`deploy/production/compose.yml`](../../../deploy/production/compose.yml); the DR plan says its §4.1–§4.7 describe the
multi-VM *target* and §4.8 what the repository actually ships), the build and release path that produces it, the
platform-operator plane, and the vendors the register and the integration catalog name.

Tagged **target** and never counted as a control: the Proxmox VLAN trust zones, mTLS on every hop, LUKS with TPM keys, a
streaming replica, an HSM-held KEK and the Talos/Kubernetes platform (ADR-0050 is **Proposed**). The architecture
documents describe these; the repository does not ship them.

Out of scope: each hospice tenant's own risk analysis as a covered entity; the hosting providers' physical safeguards
(reached only through vendor BAAs, CW-BA-01); the tenant-held vendor accounts (CW-AC-17).

## Document map

| File | Content |
|---|---|
| [`01-assets-and-data-flows.md`](./01-assets-and-data-flows.md) | Information and system assets (`A-…`), third parties (`P-…`), data flows (`F-…`), trust boundaries |
| [`02-scoring-method.md`](./02-scoring-method.md) | Likelihood and impact scales, score bands, how register status limits control credit, the decisions that belong to the owner |
| [`03-threats-and-vulnerabilities.md`](./03-threats-and-vulnerabilities.md) | Threats (`T-…`) from the Security Hardening guide and the module specs; vulnerabilities (`V-…`) from the register's open rows and the architecture documents' own "not built" notes |
| [`04-residual-risk-register.md`](./04-residual-risk-register.md) | Risks (`R-…`) joining asset, threat, vulnerability and controls; per-asset roll-up; blank score and treatment cells |
| [`05-sign-off.md`](./05-sign-off.md) | Blank review and signature page |

## Basis

- Register read at commit `0937b5eb1`. A cited row's status, owner and `review_by` are that commit's; re-read the register at review.
- IDs (`A-`, `P-`, `B-`, `F-`, `T-`, `V-`, `R-`) are local to this pack. A register row keeps its own id (`CW-…`).
- Facts are cited, not restated. Where a fact is a count or a list the repository generates (modules, routes, tables), the
  pack points at the generator (`architecture/module-manifest.ts`, `audit/implementation-status/IMPLEMENTATION_STATUS.md`)
  instead of copying it.
- **Owner statement** marks register text that records the owner's word with no repository evidence (for example
  CW-CP-01's WAL archiving). The method gives such a statement no control credit.
- The Architecture (§ on Module 30) describes a product workflow for the annual analysis (HIPAA Security Officer owns,
  Compliance Officer co-signs; NIST SP 800-66r2 and the HHS SRA Tool as templates; a risk register with severity,
  likelihood, owner, target date and status). Whether Module 30 implements it is not verified here; this pack does not
  depend on it, and its register carries the same columns so it can be transcribed.

## Differences between sources, to reconcile at review

Found while building the pack. The pack follows the register and the code; the owner decides which document is edited.

1. **Security Hardening §3.2.3 banner** ("Declared, not enforced (AD-13)": no server-side idle expiry) predates
   [`packages/auth/src/identity/session-timeout.ts`](../../../packages/auth/src/identity/session-timeout.ts), whose header says
   it is the server reader of `SESSION_POLICY`. CW-AC-04 reads `implemented` on screen-lock and device-session suites. This
   pack did not re-verify the banner.
2. **Security Hardening §3.2.3** says passkeys are required for `platform_ops` and `org_admin`; CW-AC-45 records that the
   server enforces the passkey requirement only when `CHARTWARDEN_MFA_ENFORCEMENT=true`. Treated as an open vulnerability (V-03).
3. **Security Hardening §6.5** states service-to-service authorization is "TARGET — NOT BUILT" and that a static shared secret
   (`INTERNAL_SERVICE_TOKEN`) names any tenant through a caller-supplied `x-internal-org-id` header. The code still has that
   shape (`apps/backend/src/bootstrap/plugins/authenticate.ts`); `arch:request-header-auth` classifies the header as read only
   inside the verified branch. **No register row covers the shared-secret model** (V-05).
4. **Security Hardening §4.2, §4.3, §7.1** describe LUKS/TPM, mTLS and VLAN zones as the design. The "TODAY" notes in §4.2 and
   §4.3 cover only the object-store, KEK and Valkey rows; the LUKS, mTLS and zone statements and §7.1 carry none. The
   single-host stack has none of the zones.
5. **Security Hardening §3.2.2** lists a hash-chain seal over the audit log as future work, which matches
   `packages/audit/src/integrity/index.ts` (the seal job is inert until `audit_hash_chain_enabled`). CW-AU-01's title says
   "integrity-checked trail"; what that covers is the append-only GRANT assertion and the sample-versus-backup comparison.
6. **Pangolin.** The Hardening guide, Architecture §19 and the DR plan's failover text describe a Pangolin edge. ADR-0049
   says production runs host nginx without Pangolin, the DR plan's status banner says there is no Pangolin edge, and
   `compose.yml` says host Nginx is the sole ingress. The pack treats Pangolin as target.

## Weaknesses no register row assesses

Named in file 03 and carried into file 04. Each is a weakness the architecture documents, the compose file or the code
record, and the register does not. Whether any becomes a register row is the owner's decision (file 02, D6); adding a row is a
separate, approved register change, not part of this pack.

| ID | Weakness | Where recorded |
|---|---|---|
| V-05 | Static shared secret for internal callers; the tenant comes from a caller-supplied header | Hardening §6.5; `authenticate.ts` |
| V-06 | Four encryption keys, the tenant KEK among them, are held in the application environment, not an HSM | ADR-0045; Hardening §22.1 |
| V-19 | Valkey runs with no password or TLS and holds the permission cache, limiter keys and one-time link tokens | `compose.yml`; `packages/auth/src` |
| V-21 (part) | The `chartwarden_destruction` role's DELETE on `audit_event`, and an integrity report that cannot see grant drift on it | Hardening §13.1 |
| V-34 | One interim owner holds all four security governance roles; no penetration test; no independent reviewer | Hardening §2.1; AI Governance §3.2 |
| V-37 | `api`, `worker` and `hl7-listener` hold a BYPASSRLS platform login and a destruction login in their environment; tenant isolation on the request path rests on code choosing the right pool | `compose.yml`; `scripts/db/provision-runtime-roles.ts` |

## Not evidenced in this repository

HIPAA expects these administrative and physical safeguards; the repository holds no evidence for them, so the pack records
them rather than scoring them: workforce training and sanction records (§164.308(a)(1)(ii)(C), (a)(5)), background checks
(Hardening §3.2.6), quarterly access-review records (Ops Runbook §12.2), executed BAA copies (the register points at the
platform BAA record, not at contracts), a third-party penetration test (Hardening §2.1: "None yet"), the production hosts'
disk-encryption state (CW-AC-05) and physical safeguards. The owner decides which become entries in the register.

## Keeping it current

Annual per Ops Runbook §12.1 (calendared for January in §3.5); the threat model quarterly and on the triggers in Hardening
§3.3 (a module with a new attack surface, a vendor with PHI access, an incident, a regulatory change). When a register row
changes status, update the risks that cite it. Never change a score without a dated entry in the sign-off page's change log.
