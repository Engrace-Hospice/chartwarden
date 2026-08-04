# 07 — Workflow Conformance Report

**Audit date:** 2026-08-03 · **Branch:** `main` @ `91e5b09` · **Method:** four end-to-end workflow traces through code (navigation → screen → action → API → authorization → persistence → resulting state), grounded in `apps/web`, `apps/portal`, `apps/admin`, and the generated backend client.

## Personas (derived from roles + screens)
Clinician (RN/LPN), Clinical Supervisor, Intake Coordinator, Biller, Org Admin, Compliance/QAPI officer, Field clinician, On-call triage nurse, IPU charge nurse, Bereavement counselor, Platform Ops, Patient/Family (portal). The staff app's role-home groups screens by `navGroup`, but the sidebar ignores it (UI-001).

## Workflow trace summary

| # | Workflow | Persona | Main path OK? | Verdict |
|---|---|---|---|---|
| A | Sign / cosign an encounter (M8) | RN, Supervisor | **No — read-only shell** | FLOW-001/003 |
| B | Intake → admission → activation (M5/M6) | Intake coordinator | **No — read-only shell** | FLOW-001/002 |
| C | Assemble & submit a Medicare claim (M23) | Biller | **No — fails at runtime** | FLOW-008 |
| D | Invite a user & assign roles (M2/M3) | Org admin | **No — undeliverable + no role UI** | FLOW-007 |

### Workflow A — encounter signing (BROKEN)
Backend is complete: 31 write routes (`08-encounters/routes/encounters-routes.ts:103-405` — create, finalize, sign, void, cosign request/sign, addenda). The web module makes **zero** `client.POST` calls (5 GETs). `cosignature-queue.tsx:69,113-120` renders a 48-hour SLA countdown and a "Past hard cap" KPI with **no cosign action**; `encounter-read.tsx:216-231` is navigation-only and loops back to the queue. `my-drafts.tsx` is structurally always empty (drafts come only from the M17 seeder whose producer event is not emitted). Broken transitions: create/author/finalize/sign/cosign/addendum all dead; missing states: no toast/confirm infra, filters+selection lost on refresh, errors render as a flat unannounced EmptyState with no retry.

### Workflow B — intake → admission (BROKEN)
One write in all of M5+M6 (add address). "Admit patient" CTA (`patient-list-census.tsx:186`) lands on a read-only inbox; a referral row navigates to unregistered `/referrals/:id` → chromeless 404 (FLOW-002); `admission-detail.tsx:126` shows a non-interactive "Ready to activate" pill; `patient-election-cert.tsx` (439 lines) is fully read-only while all sign routes exist server-side. The one wired write saves silently with no confirmation and silently demotes the existing primary (`patient-chart.tsx:713,724-733`). Nothing is URL-synced; client-side filtering silently misses unloaded pages.

### Workflow C — Medicare claim (BROKEN AT RUNTIME)
All screens registered; writes wired but every one fails: mandatory `Idempotency-Key` never sent (400); validation re-run has no UI; override records without re-evaluating so a claim with failures can never reach `ready`; replace/void payloads omit the required reason (≥20 chars) and `ifVersion` (400); step-up collects a password then discards it, and 403 never links to the existing `/step-up` screen; wizard state is `useState` only (refresh loses everything); submit is 202-async with no polling; pagination cursor never used. (FLOW-008; contract root PARAM-001/002.)

### Workflow D — invite user / manage roles (BROKEN)
Invite POST works but sends only `{email}` (invitees role-less); the invitation is **undeliverable by design gap** (no email sender — `identity-stores-db.ts:19-25`; token never returned) while the UI prints "Invitation sent"; accept requires an authenticated actor but there is no sign-up/set-password screen; role assignment/creation/deletion routes exist with **zero UI callers**; Remove-member has no confirmation; pending invites are unlistable and un-rescindable; `/admin/staff` is registered with no `requiredPermission` (UI-012). (FLOW-007.)

## Broken-transition / missing-recovery inventory

| Class | Where | Finding |
|---|---|---|
| Screen with no route (dead nav) | `/referrals/:id` | FLOW-002 |
| Action button with no behavior | "Ready to activate", cosign queue, "Admit patient" | FLOW-001/003 |
| False success | "Invitation sent"; silent address save; 100% EVV | FLOW-007, UI-003, UI-010 |
| No recovery path | any failed clinical read (no retry); outage → logout | UI-002, FLOW-004 |
| Lost state on refresh | queues, wizards, filters, pagination | UI-009 |
| Missing confirmation on destructive action | remove member; no ConfirmDialog primitive | UI-010 |
| Unreachable recovery screens | `/403 /error /offline /maintenance /expired /suspended` | FLOW-005/006 |
| No session-expiry / offline detection | client has request-only middleware | FLOW-005 |

## Completion criteria not met
None of the four traced workflows satisfies report 32's "complete workflow" bar: discoverability, validated inputs, preserved intermediate state, progress on long steps, recovery paths, cancellation, clear completion, persisted result, and revisitability all fail on at least workflows A–D.

## Workflow priorities (remediation order)
1. **Onboarding (FLOW-007)** — nothing else is reachable without users and roles.
2. **Clinical documentation (FLOW-001/003)** — the core EHR job.
3. **Billing (FLOW-008)** — revenue; also the clearest contract fix (PARAM-001/002).
4. **Resilience states (FLOW-004/005/006)** — wire the already-built system pages.
