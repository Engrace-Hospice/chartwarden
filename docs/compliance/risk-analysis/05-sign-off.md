# 05 — Review and sign-off

Part of the [risk analysis pack](./README.md) for CW-RA-01.

> **This page is blank.** Engineering has not completed, signed, dated or approved anything on it, and has named no person.
> Every field below is for the accountable owner. Until the fields in §1 and §2 are completed by the people they name, the pack
> is a draft and the register row CW-RA-01 stays `partial`.

## 1. What is being reviewed

| Field | Entry |
|---|---|
| Pack revision (commit SHA of this directory) | |
| Register read (commit SHA of `compliance/controls.yaml`) | |
| Files covered | 01 assets and data flows · 02 scoring method · 03 threats and vulnerabilities · 04 residual-risk register |
| Scope decision (file 02, D1) | |
| External assessor engaged (file 02, D7) | |
| Where the signed copy is filed, and the retention period (file 02, D9) | |

## 2. Review and signature

Roles follow Hardening §2.1 and Ops Runbook §12.1 step 7 (sign-off by the compliance officer and engineering). The owner may
add or remove roles (file 02, D8). One person may hold more than one role only if the owner records why.

| Role | Name | Files reviewed | Date | Signature |
|---|---|---|---|---|
| Security Owner (HIPAA Security Officer) | | | | |
| Compliance Officer (Privacy Officer) | | | | |
| Engineering | | | | |
| Independent reviewer or external assessor | | | | |

## 3. Decisions recorded

File 02 §8 lists them. A blank row means the decision has not been made.

| # | Decision | Made by (role) | Date | Outcome |
|---|---|---|---|---|
| D1 | Scope | | | |
| D2 | Scales, anchors and band thresholds | | | |
| D3 | Control-credit rule and overrides | | | |
| D4 | Inherent and residual scores, asset roll-up | | | |
| D5 | Treatment per risk; who accepts which band | | | |
| D6 | Items not evidenced in the repository, and weaknesses no register row assesses: which become register entries | | | |
| D7 | External assessor | | | |
| D8 | Independent review | | | |
| D9 | Cadence and filing | | | |

## 4. Accepted risks

Residual risks the owner accepts rather than mitigates. A High or Critical risk needs the roles in file 02 §6.

| Risk ID | Residual score | Rationale | Accepting role(s) | Date | Review by |
|---|---|---|---|---|---|
| | | | | | |

## 5. Change log

One line per change to a score, a treatment or the scope after the first signature (file 02 §7, step 6).

| Date | Change | Risk ids | Role |
|---|---|---|---|
| | | | |

## 6. After signature (for engineering to follow, not to anticipate)

1. File the signed copy where §1 says, for the retention period §1 records.
2. Re-read `compliance/controls.yaml` and compare each cited row with file 04's status labels (file 04 §4).
3. Update the CW-RA-01 row only to what then exists. The register's own rule is that an `implemented` row needs automated
   evidence (a script or a CI reference) because "a control proven only by a document is a control on paper"
   (`compliance/controls.yaml` header; rule 2 of `scripts/check-compliance-controls.ts`). A signature on its own does not meet
   that rule; what the owner and engineering attach as automated evidence, if anything, is open.
4. Close issue #1134 only when the owner confirms a signed copy exists.
