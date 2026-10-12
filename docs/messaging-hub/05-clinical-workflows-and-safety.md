# 05 — Clinical Workflows, Authorization & Safety

> Part of the [Messaging Hub plan](./README.md). All tests use **simulated hospice cases with no real PHI** (synthetic tenants/patients).
> Regulatory references are anchors, not a compliance determination; Oregon and other state rules, breach-notification duties and
> effective dates need separate legal/compliance review.

## 1. Workflows (acceptance scenarios)

Each workflow becomes a live suite (`test:messaging-hub:<workflow>:live`) with a `package.json` script and a `ci.yml` job.

### A — Uncontrolled pain escalation (Phase 4)
1. RN opens the authorized patient conversation → **Urgent clinical** → SBAR form; selects qualified recipient/role.
2. System creates an ack-request (recipient, deadline), delivers per policy (in-app + configured channels, no PHI out-of-band).
3. Overdue → next M19 tier; delivery failure → next route immediately; exhausted → `failed_unreachable` + supervisor + ops.
4. Qualified clinician **acknowledges** (explicit action), coordinates; any medication order goes through M11/M12 — not chat.
5. Outcome documented (chart promotion or task closure), request `resolved`.
**Safety rule:** UI states messaging is not the emergency path; critical symptoms follow the agency telephone/emergency procedure.
**Failure checks:** opened-not-acked stays pending; duplicate job → one escalation; quiet hours don't suppress; lock screen has no PHI.

### B — End-of-shift handoff (Phase 3)
Outgoing nurse picks caseload patients → system pre-fills from seams (unresolved symptoms, pending meds, visits, callbacks, tasks) → offers
to incoming nurse → incoming **accepts per item** → responsibilities transfer → items appear in the incoming shift inbox.
**Failure:** no acceptance by deadline → accountability stays with sender, supervisor alerted per policy.

### C — IDG coordination (Phase 3)
Authorized member opens IDG-linked patient discussion, adds concerns + assessment/care-plan links → team discusses → accountable clinician
records decisions as tasks or a promotion request → plan changes go through M7/M14 approval.
**Failure:** a discussion message cannot complete a meeting or alter the plan of care.

### D — Medication clarification (Phase 3)
Aide opens patient thread → links the medication record → sends concern to assigned RN (task) → RN evaluates, contacts prescriber → order
entered/signed in M11 (M12 for e-prescribing) → task closed with reason.
**Failure:** instruction typed in chat never becomes an order; aide has no ordering route.

### E — Death / discharge / transfer (Phase 3)
Admissions emits lifecycle event → conversations/tasks/handoffs evaluated → routine posting restricted per policy → open follow-ups
reassigned or closed with justification → history stays accessible only under retention + authorization (bereavement channel unaffected).

### F — Workforce offboarding (Phases 1 + 5)
Identity marks employee inactive → sessions/devices/subscriptions revoked → memberships inaccessible → owned tasks/escalations/handoffs
reassigned for review → audit stays attributable.
**Failure:** offboarding never deletes messages and never leaves an urgent item ownerless.

## 2. Authorization matrix

Proposed default (tenant-configurable only in the *tightening* direction). ✅ allowed · ◐ conditional · ❌ denied. All patient-linked rows also
require current patient access (care team / caseload ABAC).

| Action | Assigned clinician | Hospice aide | Team lead / clinical lead | Org admin | Compliance |
|---|---|---|---|---|---|
| View patient conversation | ✅ | ◐ assigned scope | ◐ scope | ❌ unless also clinically authorized | ◐ audited oversight / break-glass |
| Send message | ✅ | ✅ | ✅ | ◐ | ◐ limited |
| Initiate urgent escalation | ✅ | ✅ | ✅ | ◐ | ❌ |
| Acknowledge clinical responsibility | ◐ qualified role | ◐ receipt only | ◐ if qualified | ◐ if qualified | ❌ |
| Manage membership | ◐ own team | ❌ | ✅ | ◐ delegated | review only |
| Promote message to chart | ◐ authorized clinical role | ❌ | ◐ | ◐ role-dependent | ❌ |
| Create/modify order from chat | ❌ (use M11) | ❌ | ❌ | ❌ | ❌ |
| Export message history | ❌ | ❌ | ◐ limited | ◐ approved | ◐ authorized |
| Configure retention / legal hold | ❌ | ❌ | ❌ | ◐ delegated | ✅ policy authority |
| Break-glass | ◐ eligible | ◐ policy | ◐ eligible | ❌ automatic | review & oversight |

**Mandatory rules:** admins have no implicit PHI access; aides cannot acquire prescribing authority through chat; revoked staff lose
server-side access immediately; break-glass needs justification, a time limit and a post-review.
New permission keys are registered in M3 with defaults, and each is composed by a route (`arch:abac-composed`).

## 3. Compliance evidence matrix (maintain as a living table)

| Requirement | Control in this plan | Test / evidence | Owner |
|---|---|---|---|
| 42 CFR §418.56 — IDG coordination & info sharing | Care-team/IDG-linked threads, handoffs, tasks, promotion | Workflows B, C suites; communication timeline report | Clinical lead |
| 42 CFR §418.104 — clinical record content/authentication | Chart promotion into owning modules with authentication; chat is not the record | Promotion attribution test; no-order-from-chat test | Clinical lead / Compliance |
| 45 CFR §164.312(a) access control, (d) authentication | RBAC+ABAC, per-route checks, session/device revocation | IDOR/RLS suite; revocation tests | Security |
| §164.312(b) audit controls | Audit on every mutation + individual read events | Audit-landing live assertions | Security |
| §164.312(c) integrity | `body_sha256` + revisions + nightly verify | Hash-verify run records | Platform |
| §164.312(e) transmission security | TLS/WSS; no PHI out-of-band | Template snapshot tests; sanitiser tests | Security |
| §164.316 documentation/retention | This plan, ADRs, runbooks, drill records | Doc gates (`check-adr-docs` etc.), drill evidence | Compliance |
| §164.308(a)(7) contingency | Restore rehearsal, escalation fallback drill | Rehearsal report | Platform / Clinical ops |

## 4. Hazard log seed

Severity (S) 1–5, likelihood (L) 1–5 before controls. Review before Phase 4; the clinical lead owns closure.

| ID | Hazard | S | L | Controls | Residual owner |
|---|---|---|---|---|---|
| H-01 | Urgent message treated as delivered when only pushed | 5 | 3 | Separate states; ack required; unreachable queue | Clinical lead |
| H-02 | Wrong recipient (stale roster/time zone) | 5 | 3 | M19 roster at send time; confirm-recipient step; tier fallback | Clinical ops |
| H-03 | Messaging used as sole emergency channel | 5 | 3 | UI notice; policy; training; drill | Clinical lead |
| H-04 | Order/instruction in chat acted upon as an order | 5 | 3 | No order route; banner on medication links; training | Pharmacy / Clinical lead |
| H-05 | PHI leaks via lock-screen/SMS/email | 4 | 3 | Sanitiser + template snapshots | Security |
| H-06 | Departed/reassigned staff still receive PHI | 5 | 2 | Revocation events; socket drop; access review | Security |
| H-07 | Handoff dropped (no acceptance) leaves patient unowned | 4 | 3 | Sender retains accountability; supervisor alert | Clinical ops |
| H-08 | AI summary omits/changes clinical meaning | 4 | 3 | Source citations; uncertainty; human action only | Clinical lead |
| H-09 | Duplicate escalation/ack due to retries | 3 | 4 | Idempotency keys; dedup timers | Platform |
| H-10 | Empty thread displayed when load failed | 3 | 4 | Distinct UI states (Phase 0.7) | UX |
