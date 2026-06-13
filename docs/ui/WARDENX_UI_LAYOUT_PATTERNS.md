# WARDENX_UI_LAYOUT_PATTERNS

Version: 1.0
Status: Layout Pattern Glossary
Scope: Shared reference for all WardenX UI screen specifications

---

## Purpose

The WardenX screen specs reference layout patterns by name — "Use Work Queue",
"Use Dashboard", "Patient Workspace + Stepper Workflow" — but never define them. This
document is the **single source of truth for those names**: what each pattern is, the
regions it is built from, when to use it, how it composes with others, and how it behaves
responsively.

A screen spec should say *which* pattern it uses; this document says *what that means*.

> **Reverse-engineered, not invented.** Every pattern below was derived from how it is
> actually used across the 30 v2 screen specs. Patterns are marked **[named in specs]** when
> a spec already invokes the name, or **[proposed]** when the layout was drawn but never
> named (the platform/portal screens). Proposed names are recommendations to normalize the
> corpus, not retroactive claims.

---

## How to read this document

WardenX layouts are built in three tiers:

1. **Regions** — atomic UI zones (Page Header, KPI Strip, Right Detail Panel…). The
   vocabulary every pattern is assembled from.
2. **Patterns** — named arrangements of regions (Work Queue, Dashboard, Stepper Workflow…).
   A screen picks one **base pattern**.
3. **Compositions** — a base pattern plus one or more **modifiers**, written with `+`
   (e.g. `Work Queue + Patient Detail`). See [Composition rules](#composition-rules).

---

## Tier 1 — Shared regions (the building blocks)

These are the recurring zones. Patterns are defined in terms of them, so they are specified
once here.

| Region | What it is | Notes |
|---|---|---|
| **Top Navigation** | Global app nav bar (tenant, module switch, search, user). | Present on all authenticated app screens; omitted from spec diagrams unless load-bearing. |
| **Page Header** | Screen title, primary context, page-level actions, breadcrumb. | The default top region for list/queue/dashboard screens. |
| **Context Header** | Header bound to a *specific record* (Referral Header, Cost Report Header, On-Call Header). | A Page Header specialized to the entity in focus; carries that entity's key identifiers + status. |
| **Patient Banner** | Persistent patient-identity strip (name, MRN, DOB, code status, allergies, benefit period). | Required on every clinical screen scoped to one patient. Sticky on scroll. |
| **KPI Strip** | Horizontal row of summary metric cards. | Read-only; each card may be a saved filter into the queue below it. |
| **Filter Bar** | Inline filter/search controls above a table. | For saved/named queries, pair with a "Save query" action. |
| **Work Table / Queue** | The primary data grid (rows = work items). | Sortable, selectable, paginated; row → opens Right Detail Panel. |
| **Right Detail Panel** | Right-docked panel showing the selected row/record's detail + contextual actions. | Collapses to a full-screen drawer on tablet/mobile. The most common modifier surface. |
| **Left Nav Rail** | Left-docked navigation *within* a screen (step list, worksheet tree, settings sidebar, assessment list). | Distinct from Top Navigation; scopes content in the center. |
| **Center Workspace** | The main editing/reading surface between left and right rails. | Form, document, worksheet, or results. |
| **Sticky Footer Actions** | Pinned action bar at the bottom (Save / Complete / Sign / Next). | Use whenever primary actions must stay reachable during long scroll/data entry. |

---

## Tier 2 — Base patterns

### App Shell **[proposed — foundational]**

**Intent.** The global chrome every authenticated screen renders inside: Top Navigation, a
Left Nav Rail, and a content outlet. It is the frame, not a content pattern — every other
base pattern renders within it.

**Structure**

```text
Top Navigation (org context · search · notifications · user menu)
[ Support / Degraded-mode Banner ]
Left Nav Rail (role-filtered module groups)  |  Content Outlet
```

**When to use.** Exactly once, as the application container. A screen spec references App
Shell only when it *is* the shell (and its role-based home, which uses Dashboard for content).

**Used by.** App Shell & Role Home.

### System Page **[proposed]**

**Intent.** A centered status page (error, offline, maintenance, no-access). Icon + plain
message + a forward action; no PHI, no stack traces.

**Structure**

```text
Centered Status
  Icon · Headline · Explanation
  Primary Action [ · Secondary ]
  [ correlation id ]
```

**When to use.** Any 4xx/5xx/offline/maintenance/expired/suspended state. Distinct from Auth
Flow — no form fields or identity flow, just a status message and a way out.

**Used by.** System / Utility Pages.

### Auth Flow **[proposed]**

**Intent.** Pre-application identity steps — a single focused action on a centered card.

**Structure**

```text
Centered Card
  Brand / Context
  Step Content (one action)
  Primary Action
  Secondary / Recovery Links
```

**When to use.** Sign-in, MFA, org-select, password reset, invite acceptance, screen-lock,
step-up — anything outside the App Shell. Accessibility is first-class.

**Used by.** Authentication & Session.

### Work Queue **[named in specs]**

**Intent.** Triage and act on a list of work items, viewing detail without leaving the list.
The default pattern for any "list of things with statuses that someone works through."

**Structure**

```text
Top Navigation
Page Header
[ KPI Strip ]          ← optional; include when triage-by-metric matters
[ Filter Bar ]         ← optional; include for saved/complex queries
Work Table / Queue  |  Right Detail Panel
```

**When to use.** A bounded set of records with a status lifecycle and an owner, worked
through over time.

**Responsive.** Right Detail Panel → full-screen drawer; KPI Strip → horizontal scroll or
2-up grid; table → priority columns only with row expand.

**States.** Always specify: empty, loading, error, no-permission, zero-after-filter.

**Used by.** Audit Log Viewer, Feature Flags, Staff Management, Document Management,
On-Call Triage, Denials Management, Eligibility Verification, Remittance/ERA Posting,
Bereavement.

---

### Dashboard **[named in specs]**

**Intent.** Monitor a domain at a glance — metrics, trends, and the records driving them.

**Structure**

```text
Top Navigation
Page Header
KPI Strip
Charts (forecast / trend / distribution)
Contributing-records Table   |  Right: Risk / Assumptions / Actions
```

**When to use.** The user's job is *understand status + spot risk*, not *work a queue*.
Read-heavy; actions are secondary (refresh, export, flag, annotate).

**Responsive.** Charts stack single-column; table moves below charts; right panel → drawer.

**Used by.** Cap Management; Field Safety (desktop side).

---

### Stepper Workflow **[named in specs]**

**Intent.** Guide one record through an ordered, multi-step process with progress and
gating between steps.

**Structure**

```text
Top Navigation
Context Header
Left Nav Rail (Steps / Worksheets)  |  Center Workspace (current step)  |  [ Right: context ]
Sticky Footer Actions (Back / Save / Next / Complete)
```

**When to use.** A process with discrete stages, completion %, and validation gates
(intake, certification, cost-report assembly).

**Responsive.** Left step rail → top horizontal stepper or dropdown; footer stays sticky;
right context → collapsible.

**States.** Per-step: not-started / in-progress / complete / blocked; plus screen-level
validation-failed.

**Used by.** Admissions/Referral Intake, Cost Report Workspace, Election & Certification.

---

### Patient Workspace **[named in specs]**

**Intent.** A patient-scoped working surface; everything below the banner is about *this*
patient.

**Structure**

```text
Top Navigation
Patient Banner            ← sticky, required
Context Header
<content: composed with a modifier — see below>
```

**When to use.** Any clinical screen operating on a single patient. Rarely used alone —
almost always `Patient Workspace + {Stepper Workflow | Documentation Workspace | Work Queue}`.

**Used by.** Clinical Assessments Suite, Election & Certification, Supplies/DME/Comfort Kit.

---

### Admin Hierarchy Layout **[named in specs]**

**Intent.** Manage a tree of entities; select a node, edit it, validate it.

**Structure**

```text
Top Navigation
Page Header
Entity Tree  |  Selected Entity Detail  |  Right: Configuration / Validation
```

**When to use.** Parent→child structures (Organization → Provider Entity → Location).

**Used by.** Org / Provider Entity / Location Setup.

---

### Admin Split Layout **[named in specs]**

**Intent.** Edit a matrix/grid of settings against a selectable list of subjects.

**Structure**

```text
Top Navigation
Page Header
List (subjects)  |  Matrix (subject × capability)  |  Right: Detail / Audit
```

**When to use.** Permission/capability grids where rows and columns both carry meaning.

**Used by.** Roles & Permissions.

---

### Admin Settings Layout **[named in specs]**

**Intent.** Categorized configuration with live explanation of impact.

**Structure**

```text
Top Navigation
Page Header
Settings Sidebar (categories)  |  Settings Content  |  Right: Help / Impact Notes
```

**When to use.** Many grouped settings where each change has consequences worth surfacing.

**States.** Dirty/unsaved-changes guard; per-section save; change-history affordance.

**Used by.** Tenant Settings.

---

### Admin Console **[named in specs]**

**Intent.** Internal multi-domain operator surface: find a tenant, see system state, act.

**Structure**

```text
Top Navigation
Ops Sidebar (domains)  |  [ Tenant Search + System Overview + Tenant Detail ]  |  Right: Risk / Support Actions
```

**When to use.** WardenX-internal operations spanning many tenants and subsystems.

**Used by.** WardenX Ops Console.

---

### Portal Dashboard **[named in specs]**

**Intent.** Patient/family home: a calm, single-column stack of cards.

**Structure**

```text
Portal Header
Patient Summary
Card stack (Care Team, Next Visit, Messages, Documents, Help)
```

**Constraints (the Portal family — inherited by all portal screens).**
- Plain, compassionate, non-technical language.
- Single-column, large touch targets, large type by default.
- **Accessibility is first-class:** WCAG 2.2 AA, full keyboard path, high-contrast,
  screen-reader labels — the user population skews elderly/low-vision.
- A persistent urgent-care/after-hours safety affordance.

**Used by.** Patient / Family Portal Dashboard (and the constraints govern all `portal/`
screens).

---

## Tier 2 (proposed) — platform & portal patterns not yet named

These layouts are fully drawn in the specs but invoked with a bare `## Layout` and no
pattern name. Proposed canonical names so the corpus stops describing the same shape five
different ways.

### Detail Page **[proposed]**
Single entity, stacked read-with-actions sections (no left/right rails).
```text
Context Header
Section / Section / Section …
Actions
```
**Maps to.** Subscription Billing.

### Status Board **[proposed]**
Service/health cards + incident timeline + operational controls.
```text
Status Header
Service Card grid
Incident Timeline  +  Integration Status
Operational Controls (e.g. degraded-mode banner)
```
**Maps to.** System Health / Degraded Mode.

### Gated Action Flow **[proposed]**
Linear, approval-gated, fully-audited flow where access is the product.
```text
Subject Selection → Reason/Scope → Approval/Controls → Active Session (persistent banner) → Audit Log
```
**Maps to.** Support / Audited Impersonation.

### Conversation View **[proposed]** (Portal family)
Inbox + thread; safety banner persistent.
```text
Conversation List  |  Message Thread  |  Right: Care Team / Expectations
```
**Maps to.** Portal Care Team Messages.

### Document Viewer **[proposed]** (Portal family; the portal-facing sibling of Review Workspace)
```text
Document List  |  Document Viewer  |  Action Panel (View / Sign / Acknowledge)
```
**Maps to.** Portal Documents / Consents.

### Portal List **[proposed]** (Portal family)
Grouped chronological list + detail (no work-queue chrome).
```text
Header
Group (Upcoming) / Group (Past)
Item Detail
```
**Maps to.** Portal Visit Schedule.

### Media Room **[proposed]**
Real-time video surface; clinician and patient variants.
```text
Video Area (+ Participant Panel)  |  Visit Context  |  Chat / Notes
Controls (join/leave/mute/camera/share)
```
**Maps to.** Telehealth Visit Room.

### MAR Grid **[proposed]**
Time × medication administration matrix; each cell is a due/given/missed dose acted on in
place. Composes onto Patient Workspace.
```text
Patient Banner
Window controls (shift / day)
Rows = medications  ×  Columns = scheduled times   |  Right: Administration / PRN Reassessment / Witness
```
**When to use.** Bedside/visit medication administration where the grid *is* the record
(scheduled, PRN, comfort-kit, caregiver-attested). Distinct from a Work Queue — cells, not
rows, are the unit of work.
**Maps to.** Medications — Prescribing & eMAR.

### Scheduling Calendar **[proposed]**
Resource × time board for assigning and routing work over a day/week, with a map variant.
```text
Page Header (Day · Week · Map switch)
Left: Roster + Proposal Inbox  |  Center: Calendar Grid (rows = clinicians, cols = time)  |  Right: Detail / Conflicts / Route
```
**When to use.** Time-axis scheduling of people against slots (visits, shifts) with
drag-drop assignment and conflict detection. The time axis is the organizing principle —
contrast Bed Board, which is a state snapshot with no time axis.
**Maps to.** Scheduling / Visit Calendar.

### Bed Board **[proposed]**
Occupancy snapshot: a grid of resource cards (beds) colored by state, acted on in place.
```text
Unit Header (census KPIs · coverage status)
Bed Grid (cards grouped by room, colored by status)
Right: Resource / Occupant Detail + Actions
```
**When to use.** A fixed set of physical resources whose *current state* (occupied / dirty /
reserved) is the view — admit/transfer/discharge act on a card. Not time-gridded (that's
Scheduling Calendar) and not metric-led (that's Dashboard).
**Maps to.** IPU / GIP Bed Board.

---

## Tier 3 — Modifiers

Modifiers attach to a base pattern with `+`. They contribute regions, not whole layouts.

| Modifier | Contributes | Used in |
|---|---|---|
| **Review Workspace** | Center preview/viewer + per-item review actions (classify, link, sign, mark-reviewed). | `Work Queue + Review Workspace` (Document Mgmt), `Stepper Workflow + Review Workspace` (Admissions) |
| **Documentation Workspace** | Center clinical-form/results surface + Right "Trends / Risk / AI Suggestions". | `Patient Workspace + Documentation Workspace` (Assessments), `Work Queue + Documentation Workspace` (On-Call) |
| **Patient Detail** / **Patient/Family Detail** | Specializes the Right Detail Panel to patient (or bereaved-family) context. | `Work Queue + Patient Detail` (Eligibility), `Work Queue + Patient/Family Detail` (Bereavement) |
| **Mobile Task Flow** | A parallel single-task mobile layout (one action per screen: check-in, escalate, document-and-close). | `Dashboard + Mobile Task Flow` (Field Safety) |

---

## Composition rules

1. **Exactly one base pattern per screen.** `Work Queue`, `Dashboard`, `Stepper Workflow`,
   `Patient Workspace`, the four `Admin *` patterns, `Portal Dashboard`, or one of the
   proposed platform/portal patterns.
2. **`A + B` = base `A` with modifier `B`.** Read left-to-right: the first token is the
   base; the rest refine it. `Patient Workspace + Stepper Workflow` = a patient-scoped
   screen whose body is a stepper.
3. **`Patient Workspace` is a wrapper, not content.** It supplies the banner and patient
   scoping; it must be composed with a content-bearing pattern/modifier.
4. **`Mobile Task Flow` declares a separate mobile layout**, not a responsive reflow of the
   desktop one. Spec both surfaces.
5. **Portal family inheritance.** Any `portal/` screen inherits the Portal Dashboard
   constraints (language, single-column, accessibility, safety affordance) regardless of
   its specific pattern.

---

## Coverage matrix (pattern → screens)

| Pattern | Screens |
|---|---|
| App Shell *(proposed)* | App Shell & Role Home |
| Auth Flow *(proposed)* | Authentication & Session |
| System Page *(proposed)* | System / Utility Pages |
| Work Queue | Audit Log, Feature Flags, Staff Mgmt, Document Mgmt, On-Call Triage, Denials, Eligibility, ERA Posting, Bereavement, Patient List/Census, EVV, Claims/Billing, Notifications & Tasks, AI Governance Console, Master Data (MDM), Terminology, Integration Monitoring, FHIR/API, Volunteer Management, Clinical Content Admin |
| Dashboard | Cap Management, Field Safety, HQRP Quality, Reporting & Analytics |
| Admin Settings | Tenant Settings, User Profile & Preferences |
| Conversation View *(proposed)* | Portal Care Team Messages, Staff Messaging |
| Stepper Workflow | Admissions Intake, Cost Report, Election & Certification |
| Patient Workspace | Assessments, Election & Certification, Supplies/DME, Patient Chart, Encounter Documentation, Care Plan, Orders, Medications/eMAR, HOPE Assessment |
| Work Queue + Documentation Workspace | On-Call Triage, IDG Meeting |
| MAR Grid *(proposed)* | Medications — Prescribing & eMAR |
| Scheduling Calendar *(proposed)* | Scheduling / Visit Calendar |
| Bed Board *(proposed)* | IPU / GIP Bed Board |
| Admin Hierarchy | Org/Provider/Location Setup |
| Admin Split | Roles & Permissions |
| Admin Console | Ops Console |
| Portal Dashboard | Patient/Family Portal Dashboard |
| Detail Page *(proposed)* | Subscription Billing |
| Status Board *(proposed)* | System Health / Degraded Mode |
| Gated Action Flow *(proposed)* | Support / Audited Impersonation |
| Document Viewer *(proposed)* | Portal Documents / Consents |
| Portal List *(proposed)* | Portal Visit Schedule |
| Media Room *(proposed)* | Telehealth Visit Room |

---

## Open questions (for spec owners)

1. **Adopt the proposed names?** If yes, the seven platform/portal specs should be updated
   to `## Layout Pattern` + `Use <name>.` for consistency with clinical/revenue/admin.
2. **Right Detail Panel breakpoint** — confirm the tablet/mobile threshold at which it
   becomes a drawer (affects every Work Queue/Dashboard screen).
3. **Two patterns reference AI surfaces** ("Right: Trends / Risk / AI Suggestions"). Should
   AI-suggestion presentation be its own modifier with shared rules (provenance,
   accept/dismiss, governance disclosure) rather than ad-hoc per screen?
