# CHARTWARDEN_UI_ONBOARDING_WIZARD

Version: 2.0
Status: Screen Specification
Module: Tenant Onboarding Wizard (M34)

---

## Purpose

The Onboarding Wizard takes a new organization from provisioning to go-live in one fixed order, with every
step saved as it is done, so an operator (or the tenant's admin) can stop and resume. It enforces the
compliance gates (BAA executed, every required step settled, two people for go-live) that must hold before a
tenant becomes active.

Two surfaces share one wizard and one set of rules, all enforced by the server:

- **Platform operations** (`apps/admin`, `/tenants/:orgSlug/onboarding[/:stepKey]`): drives any step on the
  tenant's behalf, with a recorded reason.
- **The tenant** (`apps/web`, `/admin/onboarding`): the org admin and the compliance officer settle the
  steps they own.

---

## Primary Users

- ChartWarden Platform Operator (the `platform_ops` role)
- Tenant Admin (`org_admin`)
- Compliance Officer (attests go-live readiness)

---

## Layout Pattern

Use Stepper Workflow.

```text
Page head (tenant · done of total steps · lifecycle status)        [Back to tenant]
Left: Step rail (every step, in order)  |  Right: the open step
                                          - what the step is, who owns it, why it is read-only
                                          - the facts that settle it
                                          - the step's own data (list + form)
                                          - how it was settled (evidence, who, when)
                                          - actions: mark done with evidence · skip · re-open
```

Below 768px the rail becomes a horizontal scroller above the step. A step is a deep link
(`/onboarding/:stepKey`); the bare route resumes at the first step that is not settled.

---

## Steps (the platform's fixed order)

| # | Step | Owner | Settles |
|---|------|-------|---------|
| 1 | Organisation (display name, time zone) | Operator | attested with evidence |
| 2 | Plan and contract (census-banded plan, billing service) | Operator | signing the contract |
| 3 | BAA (record, document, dates) | Operator | automatic: latest BAA executed, document linked, more than 90 days left |
| 4 | Provisioning | Operator | automatic: the platform builds the tenant |
| 5 | Provider entity and NPI (CCN, NPI, EIN) | Operator or tenant | attested with evidence |
| 6 | Locations (at least one primary) | Tenant admin | automatic once a primary location exists, else attested |
| 7 | Billing: clearinghouse (Stedi, Claim.MD or outside) | Operator or tenant | automatic once the choice is settled, else attested |
| 8 | Billing: MAC credentials | Operator or tenant | automatic once a credential exists, else attested; skipped automatically under "outside" |
| 9 | Billing: payer enrollment | Operator or tenant | attested with evidence; skipped automatically under "outside" |
| 10 | e-Prescribing (DoseSpot) | Operator or tenant | automatic once the tenant's DoseSpot configuration is active, else attested |
| 11 | People: first admin | Operator | automatic: the first admin accepted their invitation |
| 12 | People: compliance officer | Operator or tenant | an officer is assigned |
| 13 | Sample data (optional) | Operator | attested; does not gate later steps |
| 14 | Go-live | Compliance officer, then Operator | the two-party approval; never attested or skipped |

A step is **locked** until every earlier required step is done or skipped (the server refuses an out-of-order
write with 409 and names the step to finish first). Locked steps can be read. Data entered for an earlier step stays
editable; editing it while a go-live attestation is pending voids that attestation.

A step is **skipped** only where it does not apply: MAC, payer enrollment, DoseSpot and sample data. Every other
step is settled by evidence or by its own facts.

---

## Tenant Lifecycle

`signup_intent` → `provisioning` → `onboarding` → `active` → (`suspended` / `at_risk`) → `offboarding_initiated` →
`final_export_pending` → `retained` → `destruction_pending` → `destroyed`.

The wizard is read-only while the tenant is provisioning and once it is active. `onboarding` to `active` is not a
status an operator applies: it is the go-live approval below (the status route answers 409).

---

## Go-Live (two people)

1. The tenant's compliance officer attests readiness (fresh step-up) in the tenant app. An attestation is
   approvable for 14 days.
2. A **different** platform operator approves (fresh step-up, a reason). Approval re-judges the activation guards at
   that instant (every required step settled, BAA executed, BAA more than 90 days from expiry) and lists every one that
   fails. The operator who recorded the BAA cannot approve. The tenant then goes active and its organization opens.
3. A pending attestation can be revoked (with a reason); the officer attests again. Any data change while it is pending
   revokes it automatically.

Panel states: not ready (what is still open, each a link), awaiting the officer, awaiting approval (approve or
revoke; an expired attestation can only be revoked), live (approved by, why), closed.

---

## Writes by the operator

Every write needs a fresh step-up and is refused for an AI principal. A refused step-up offers Re-verify and carries
the typed form through it (never a credential or a write-only value). Each write carries a reason (8 to 500 or
1000 characters, counted after whitespace is collapsed) that is recorded in the audit trail the tenant can read. A
data write carries one Idempotency-Key per attempt, renewed by any answer (the server caches a refusal under the key).
A credential update is pinned to the version the operator read (If-Match); a stale pin reloads the record.

---

## Empty, Loading and Error States

- Loading: a spinner naming the thing being loaded; a step panel loads its own data.
- No data yet: an honest sentence and the one action that creates it ("No location yet", "No published plan to sign").
- Refused: the server's reason in plain words, with the next step (Re-verify, go to the earlier step, fix the field,
  reload the record that changed).
- Unreachable: a retryable message; a reference id for support when the failure is not the operator's doing.

---

## Actions

- Mark a step done with evidence (what was checked and by whom, an optional reference, a reason)
- Skip a step that does not apply (reason)
- Re-open a settled step to edit (reason; refused while a go-live attestation is pending)
- Save a step's data (provider entity, location, MAC credential, BAA, organisation profile)
- Sign the contract; change the billing service
- Assign the compliance officer
- Approve go-live; revoke a go-live attestation
