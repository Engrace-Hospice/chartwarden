# P0 — Foundation, Core & Cross-cutting Overlays

> Generate these first: the app chrome every screen renders inside, the most-reused
> patient surfaces, and the **shared overlay symbol set** (Guardrail / Ceremony / Provenance /
> Sensitivity) that later phases compose rather than re-invent.
>
> Prepend the [Lantern preamble](./README.md#the-lantern-preamble-prepend-to-every-generation-prompt)
> to every prompt. After generating, record node ids in [`../SCREENS.md`](../SCREENS.md).

---

## 0.0 Design-system symbol set (build before screens)

Install the Lantern variables (`set_variables`) and create reusable Pencil **symbols/components**
so screens reference them:

- **Top Navigation (glass)** — 64px; org/tenant switcher + lantern brand mark (left), `⌘K` global
  search (center), notifications · help · user menu (right). A Degraded-mode banner slot beneath.
- **Left Nav Rail** — role-filtered module groups; active = indigo text on `primary-tint` fill.
- **Patient Banner** — sticky identity strip (see 0.4); reused on every clinical screen.
- **Lantern Card, KPI Card, Buttons (incl. Guarded), Inputs (incl. masked), Status Pills, Table,
  Countdown Chip, Guard Chip** — per DESIGN.md §6–§7.
- **Status-pill taxonomy frames** — one frame each for patient / claim / order-visit /
  document-render lifecycles so colors+glyphs are defined once.

---

## 0.1 App Shell & Role Home — M01 · `Use App Shell` (Dashboard content)

```
Design "App Shell & Role Home" for WardenX hospice EHR. Module M01.
LAYOUT: App Shell — Top Navigation (glass, org context · ⌘K search · notifications · user) over a
[Support/Degraded-mode banner slot] over (Left Nav Rail | Content Outlet). The content outlet
renders a role-based home using the Dashboard pattern.
ROLE HOME CONTENT: greeting in Fraunces display-md ("Good evening, <name>"); a KPI strip (My
patients, Visits today, Unsigned notes, Tasks due, Alerts); a "Needs you now" work list (overdue
recerts, unsigned encounters, cosign requests, deadline-critical items as countdown chips); quick
actions. Role variants change which KPIs/queues show.
SYSTEMS: deadline countdown chips on time-bound items; guard chips on blocked quick-actions.
STATES: empty (new user, no caseload), loading skeleton, degraded-mode (banner visible, some
KPIs show "unavailable").
VARIANTS (frames): RN/Case Manager home · Medical Director home · Biller home · Scheduler home ·
Admin home · degraded-mode · empty/new-user · dark mode.
```

## 0.2 Authentication & Session — M02 · `Use Auth Flow`

```
Design "Authentication & Session" for WardenX hospice EHR. Module M02.
LAYOUT: Auth Flow — centered card on warm-paper canvas; lantern brand mark; one focused action
per step; primary CTA (indigo gradient); secondary/recovery links. Accessibility first-class.
STEPS (one frame each): Sign-in (email/password + passkey option) · MFA challenge (TOTP/passkey) ·
Organization/Tenant select (for multi-org users) · Forgot password · Reset password · Accept
invitation (single-use token) · Screen lock / re-auth · Step-up authentication (the elevated
challenge reused by ceremonies — SSN reveal, EPCS, death, break-glass).
SYSTEMS: step-up frame is the canonical elevated-auth surface; reused by §0.5 ceremonies.
STATES: error (bad credentials, locked, expired token), loading, success→redirect.
VARIANTS: each step above · error states · dark mode.
```

## 0.3 System / Utility Pages — M01 · `Use System Page`

```
Design "System / Utility Pages" for WardenX. Module M01.
LAYOUT: System Page — centered status (Material Symbols Rounded icon · Fraunces headline · plain
explanation · forward action · optional correlation id in mono). No PHI, no stack traces.
VARIANTS (frames): 403 no-access · 404 not-found · 500 error (with correlation id) · offline ·
maintenance/scheduled-downtime (countdown) · session-expired · tenant-suspended.
```

## 0.4 Patient Chart — M05 · `Use Patient Workspace`

```
Design "Patient Chart" for WardenX hospice EHR. Module M05. The central per-patient hub.
LAYOUT: Patient Workspace — sticky Patient Banner over (Left: Module Nav Rail | Center: active
module / Summary | Right: Alerts / Tasks).
PATIENT BANNER (sticky): name (Fraunces headline-md) + pronouns; DOB/age/sex; MRN + MBI(last4) in
IBM Plex Mono; status badge + level of care; code status + allergies as ALERT-toned chips;
primary payer; primary caregiver + legal-rep marker; consent-gated privacy flags (shield chips);
if deceased: deceased date; if merged: "merged into <MRN>".
MODULE NAV RAIL: Summary · Demographics & Identifiers · Coverage/Payers · Care Team · Care Plan ·
Encounters · Assessments · Orders · Medications/eMAR · Documents · Election & Certification · IDG
History · Bereavement (when deceased).
SUMMARY: active problems · current benefit period + recert/F2F countdown chips · upcoming &
recent visits · active orders & meds · recent assessment scores + trend sparkline · open tasks.
SYSTEMS: Sensitivity — SSN/MBI masked `xxx-xx-####` in mono with step-up reveal; code-status &
allergy as ALERT chips; consent-gated badges. Guardrails — "Record death" opens a ceremony (step-
up). Deadlines — amendment 60-day countdown, recert/F2F countdowns.
STATES: read-only when Discharged/Deceased (except Bereavement & amendment).
VARIANTS (frames): active (full summary) · just-admitted (sparse, deep-links to start each) ·
discharged (read-only) · deceased (bereavement surfaced) · merged-redirect · SSN masked vs
revealed · dark mode.
```

## 0.5 Patient List / Census — M05 · `Use Work Queue`

```
Design "Patient List / Census" for WardenX. Module M05.
LAYOUT: Work Queue — Page Header; KPI strip (Census, Admissions today, Discharges, GIP, Recerts
due); Filter Bar (team, LOC, status, payer, deadline — saveable); Work Table | Right Detail Panel.
TABLE COLUMNS: patient (name + MRN mono), status pill, LOC, benefit period, primary team, next
visit, open-deadline countdown chip. Zebra rows, no borders, no dividers (1.75rem spacing).
RIGHT DETAIL: selected patient snapshot — banner mini, active problems, next actions, open the
chart.
SYSTEMS: deadline chips; consent-gated patients shown with shield marker; SUD patients respect
redaction in any preview.
STATES: empty, loading, error, no-permission, zero-after-filter.
VARIANTS: full census · my-caseload · by-team · deadline-critical filter · dark mode.
```

## 0.6 Global Search Results — M01 · M33 · `Use Work Queue`

```
Design "Global Search Results" for WardenX (the ⌘K destination). Modules M01 · M33.
LAYOUT: Work Queue — query header; result groups (Patients, Staff, Documents, Orders, Claims,
Screens/Actions); each row typed with an icon, mono identifier, and a permission-aware open.
SYSTEMS: results respect RLS/permission (no out-of-scope leakage); PHI in previews masked;
SUD-redacted results show as sealed.
STATES: empty (no query), no-results, loading, partial (some sources unavailable in degraded mode).
VARIANTS: mixed results · patient-only · zero-results · dark mode.
```

## 0.7 Notifications & Tasks — M01 · M36 · `Use Work Queue`

```
Design "Notifications & Tasks" for WardenX. Modules M01 · M36.
LAYOUT: Work Queue — tabs (Tasks · Notifications · Mentions); KPI strip (Due today, Overdue,
Unread); table rows = task/notification with priority, source module, due countdown chip, actor;
Right Detail = item detail + quick-complete.
SYSTEMS: deadline countdowns; guard chips where a task's action is blocked; AI-surfaced tasks
carry provenance line.
STATES: empty (inbox zero — Fraunces warmth), loading, error.
VARIANTS: tasks · notifications · overdue filter · empty/inbox-zero · dark mode.
```

## 0.8 Staff Messaging — M36 · `Use Conversation View`

```
Design "Staff Messaging" for WardenX. Module M36.
LAYOUT: Conversation View — Conversation List | Message Thread | Right: participants / patient
context. Bubbles per DESIGN.md §6.8 (me = indigo, other = surface-low). Patient-scoped threads
show a patient context chip; urgent flag uses ALERT.
SYSTEMS: PHI in patient-linked threads respects consent; SUD content sealed; composition fan-out
(roles) shown on new-thread.
STATES: empty (no conversations), loading, error, no-permission.
VARIANTS: inbox · active thread · new/compose (role fan-out) · patient-scoped thread · dark mode.
```

## 0.9 Reporting & Analytics — M33 · `Use Dashboard`

```
Design "Reporting & Analytics" for WardenX. Module M33.
LAYOUT: Dashboard — Page Header (date range, export); KPI strip; charts (census trend, LOC mix,
visit compliance, revenue); contributing-records table | Right: filters / saved reports / export.
SYSTEMS: all data RLS-scoped; reports never cross tenant; numbers tabular-nums; export is audited.
STATES: empty (no data in range), loading, error, no-permission.
VARIANTS: operational · clinical-quality · financial · saved-report view · dark mode.
```

## 0.10 Agency Command Center — M33 · M01 · `Use Dashboard`

```
Design "Agency Command Center" for WardenX (live agency-wide operational view). Modules M33 · M01.
LAYOUT: Dashboard — big KPI strip (census, admissions/discharges, GIP utilization, visits today &
completion %, unsigned notes, recerts due, cap exposure, on-call status); trend charts; a
"requires attention" cross-module work list | Right: risk / alerts / coverage status.
SYSTEMS: cap-exposure card escalates neutral→warning→ALERT(breach); deadline chips; degraded-mode
aware (cards show "unavailable").
STATES: loading, degraded-mode, after-hours/on-call mode.
VARIANTS: day · on-call/after-hours · degraded-mode · dark mode.
```

---

## Cross-cutting overlay symbol sets (design once, reuse everywhere)

### Overlay A — Guardrail blockers (`alert-dialog` template)

```
Design the WardenX "Invariant Blocking Dialog" symbol set. One template: ALERT-toned header, the
unmet invariants as a checklist (each with a fix deep-link), and two paths — Fix or Override
(override only where policy allows; captures actor + reason to audit). Glass scrim, shadow-float,
focus-trapped.
FRAMES (one per canonical blocker): Admission block · Order Signature block · Recertification
Completion block · Claim Submission block · Episode Closure block · Cap Warning/Override.
Also: the inline "Guard Chip" (disabled action + reason + fix link) and the "Gate Stepper"
(multi-condition checklist: not-started/in-progress/complete/blocked).
```

### Overlay B — Signature Ceremony

```
Design the WardenX "Signature Ceremony" symbol set — modal ceremonies for irreversible actions.
Template: what is being attested (summary), the legal/attestation text, signer identity, an
embedded step-up auth challenge (reuse §0.2 step-up), and one deliberate commit. shadow-float,
glass scrim, focus-trap.
FRAMES: Admission/Election signing · Discharge · Death pronouncement (step-up) · Order signing ·
EPCS controlled-substance (hard-token/biometric) · IDG adjournment (commit + step-up) ·
Cosignature.
```

### Overlay C — Provenance & AI

```
Design the WardenX "Provenance" symbol set (DESIGN.md §9). Three states, visually distinct:
Human-authored (default, no chrome) · AI-suggested (success-tinted container + soft halo +
auto_awesome glyph + provenance line "model · confidence · review before relying" + Accept/Edit/
Dismiss + citation link) · System-derived (quiet info chip "derived from…/imported via HL7 ADT").
Also: the governance bar (opt-out toggle, kill-switch, "hard-block category — not actionable"
state, HITL accept/reject + reason control).
FRAMES: AI suggestion card (accept/edit/dismiss) · AI suggestion in a form field (inline) ·
system-derived chip · governance bar · hard-blocked state · HITL feedback.
```

### Overlay D — Sensitivity & Consent

```
Design the WardenX "Sensitivity" symbol set (DESIGN.md §8). FRAMES: PHI masked field
(xxx-xx-#### mono + step-up reveal affordance) · SUD/42-CFR-Part-2 sealed block ("Protected —
Part 2 consent required" + lock glyph, visible-as-redaction) · consent-gated privacy badge
(shield chip + hover authority) · break-glass active-session banner (persistent ALERT bar across
top, grant reason, end-session) · break-glass initiation flow.
```
