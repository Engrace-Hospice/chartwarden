# 09 — Missing Screens Specification

**Audit date:** 2026-08-03. Each screen below is justified by an implemented backend capability with zero/minimal UI, a documented spec, or a broken workflow. Priorities follow report 30's order (security/access → core value → data integrity → recovery → onboarding → long-running visibility → admin → usability). Route counts from `apps/backend/src/modules/<dir>/routes/*`.

> Full mini-specs are given for the production blockers; the remainder are tabulated with the same fields in report `08` §3 and the roadmap `13`.

---

## M29 Unmatched-Labs / Abnormal-Result Queue
- Proposed route: `/interfaces/labs/unmatched`
- Persona: Lab / HIM staff
- Workflow: inbound lab (M29) → match to patient → acknowledge abnormal → file to chart
- Purpose: abnormal-result acknowledgment is a patient-safety loop currently invisible
- Preconditions: `interfaces.labs.view` permission; active lab feed
- Required data: unmatched observations, abnormal flags, candidate patients
- Required API support: attach-patient / acknowledge-abnormal / discard (6 routes, exist)
- Primary action: attach to patient; Secondary: acknowledge abnormal, discard
- Permissions: `interfaces.labs.manage`
- Loading / Empty / Error / Success: skeleton rows / "No unmatched labs" / retry banner / row removed + toast
- Responsive: table scrolls in an overflow-x container; usable at 390px
- Accessibility: keyboard-navigable rows, abnormal flag not conveyed by color alone
- Dependencies: M29 read-audit prefix (SEC-002)
- Acceptance: an abnormal lab can be matched and acknowledged, producing an audit row
- **Priority: P0 · Production blocker: Yes**

## M29 HL7 Interface Console
- Proposed route: `/interfaces`, `/interfaces/:feedId`, `/interfaces/messages`
- Persona: Integration admin
- Purpose: 33 M29 routes (feeds CRUD/activate/suspend/credentials/health; message logs + replay/retry) have no UI; feeds cannot be operated in production. Specs `WARDENX_UI_HL7_INTERFACE_LOGS.md` + `WARDENX_UI_INTEGRATION_MONITORING.md` exist.
- Required API support: feed lifecycle (10), message log/replay (7) — exist (4 of 33 are 501, API-002)
- Primary actions: activate/suspend feed, rotate credential, replay message
- States: health dashboard; empty = "No feeds configured"; error with retry
- Acceptance: an admin configures, activates, and monitors a feed; replays a failed message
- **Priority: P1 · Production blocker: Yes** (cannot run interfaces)

## M37 IPU Bed Board + Restraint Reassessment
- Proposed routes: `/ipu/bed-board`, `/ipu/restraints`, `/ipu/visitors`, `/ipu/staffing`
- Persona: IPU charge nurse
- Purpose: 45 M37 routes vs 4 read screens. **Restraint reassessment is a CoP timing requirement** with no UI; bed board, GIP criteria/transfer, RN coverage/break-glass, visitors, equipment lifecycle, meals, body release all lack surfaces.
- Required API support: bed board (7), restraint reassess/release (3), GIP criteria/transfer (5), RN coverage + break-glass (4), visitors (3), equipment (3) — exist
- Primary actions: assign bed, record restraint reassessment, confirm transfer
- Acceptance: a restraint reassessment can be recorded within its required window and audited
- **Priority: P1 · Production blocker: Yes (for IPU go-live)**

## Invitee Onboarding Flow (set-password / verify-email / MFA-enroll)
- Proposed route: `/accept-invitation` (complete the existing stub) + `/sign-up`
- Persona: newly invited staff user
- Purpose: closes FLOW-007 — today an invitation is undeliverable and unacceptable
- Required API support: a transactional email sender (or admin-visible invite link) + accept endpoint (route exists; `identity-routes.ts:242`) — **the sender does not exist and must be built**
- Primary action: set password; Secondary: enroll MFA, verify email
- Dependencies: role-assignment editor (below); SEC-008 org_admin provisioning
- Acceptance: invite → link/email → account creation → role grant → sign-in, end-to-end
- **Priority: P0 · Production blocker: Yes**

## Role & Permission Management Editor
- Proposed route: extend `/admin/roles` and per-member editor under `/admin/staff/:id`
- Persona: Org admin
- Purpose: role assign/create/edit/delete routes (`authz-routes.ts:133-268`) have zero UI; today roles are read-only
- Required API support: exists — **blocked by ARCH-015** (the M3 permission resolver must be wired first, or grants 403)
- Acceptance: an org_admin grants a role to a member and sees it reflected; anti-escalation enforced
- **Priority: P0 · Production blocker: Yes** (depends on ARCH-015 fix)

---

## Additional required screens (tabulated)

| Screen | Route | Persona | Why required | Priority | Blocker |
|---|---|---|---|---|---|
| M29 inbound proposals (accept/defer/reject, 5 routes) | `/interfaces/proposals` | HIM | ADT-driven chart changes need human disposition | P1 | Y |
| M30 CAHPS program (8 routes) | `/quality/cahps` | Quality mgr | CMS-mandated survey; zero UI | P1 | Y |
| M30 SRA cycles + findings + remediation (8) | `/quality/sra` | Compliance | HIPAA §164.308 requirement | P1 | Y |
| M30 measure detail / recompute; QAPI incident lifecycle (12 of 14) | `/quality/measures/:id`, `/quality/qapi/*` | Quality mgr | can't drill/recompute or triage incidents | P1 | Y |
| M30 mortality / infection / risk register (10) | `/quality/mortality` etc. | QAPI | surveillance surfaces | P2 | N |
| M32 AI governance console (32 routes) | `/platform/ai` (admin) | Platform ops | kill-switch/drift/token-ledger; no UI | P1 | Y (if `ai.full` ON) |
| M28 FHIR client console (approve/suspend/revoke/rotate, config, bulk-export) | `/admin/fhir/*` | Interop admin | partner onboarding is API-only | P1 | Y |
| M31 staff-admin portal pane (13 routes) | `/admin/portal` | Org admin | portal grants/amendment review unmanageable | P1 | Y |
| M35 tenant billing gaps (invoice PDF, payment-method, cancel/resume, 7 routes) | extend `/subscription/*` | Tenant billing admin | self-service billing incomplete | P2 | N |
| Foundation states (session-expired, permission-denied explanation, offline, maintenance) | wire existing `/expired /403 /offline /maintenance` | All | built but unreachable (FLOW-005/006) | P1 | N |
| Pending-invitations list + rescind/resend | `/admin/staff` (extend) | Org admin | invites unlistable/un-rescindable today | P2 | N |
| Outbox / job health surface | `/platform/ops/jobs` | Platform ops | no visibility into outbox depth or failed jobs (OPS-001/007) | P2 | N |
| Staffing suite (credentials/compliance, caseload, timesheets — spec only, no backend) | — | HR/Ops | documented but no module | P3 | N |
| Mobile field suite (ADR-0035 Capacitor) | mobile target | Field clinician | no `apps/mobile`; web non-responsive (UI-004) | P1 | Y (mobile strategy) |

**Do not invent beyond need:** the staffing suite and several portal sub-portals are documented but have no backend; they are P3 and should not precede the P0/P1 surfaces that back existing capabilities.
