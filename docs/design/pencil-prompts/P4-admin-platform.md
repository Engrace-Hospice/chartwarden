# P4 — Admin & Platform

> Prepend the [Lantern preamble](./README.md#the-lantern-preamble-prepend-to-every-generation-prompt).
> Admin uses the Admin pattern family (Hierarchy / Split / Settings / Console); platform/ops are
> WardenX-internal. Composes P0 chrome + overlays.

## Admin (apps/web · apps/admin)

### 4.1 Org / Provider / Location Setup — M01 · M34 · `Use Admin Hierarchy`
[spec](../screens/admin/WARDENX_UI_ORG_PROVIDER_LOCATION_SETUP.md)
```
Design "Org / Provider / Location Setup" for WardenX. Admin Hierarchy — Entity Tree (Organization →
Provider Entity → Location) | Selected Entity Detail (CMS CCN, NPI mono, timezone, addresses) |
Right (configuration · validation). VARIANTS: org · provider · location · validation-error · dark.
```

### 4.2 Roles & Permissions — M03 · `Use Admin Split`
[spec](../screens/admin/WARDENX_UI_ROLES_PERMISSIONS.md)
```
Design "Roles & Permissions" for WardenX. Admin Split — Roles list | Matrix (role × permission key,
3-segment keys) | Right (detail · audit). SYSTEMS: permission grants audited; step-up on grant
changes. VARIANTS: role matrix · permission detail · new-role · audit · dark.
```

### 4.3 Staff Management — M02 · M34 · `Use Work Queue`
[spec](../screens/admin/WARDENX_UI_STAFF_MANAGEMENT.md)
```
Design "Staff Management" for WardenX. Work Queue — staff table (name, role, credentials,
expiration countdown, status) | Right (staff detail: credentials, license mono, NPI, immunization).
SYSTEMS: credential-expiration countdown (warning→ALERT); OIG exclusion screening status; invite flow.
VARIANTS: roster · staff detail · credential-expiring · invite · deactivated · dark.
```

### 4.4 Tenant Settings — M34 · `Use Admin Settings`
[spec](../screens/admin/WARDENX_UI_TENANT_SETTINGS.md)
```
Design "Tenant Settings" for WardenX. Admin Settings — Settings Sidebar (categories) | Content |
Right (help · impact notes). SYSTEMS: dirty/unsaved guard; per-section save; change history.
VARIANTS: a settings section · unsaved-changes guard · change-history · dark.
```

### 4.5 Feature Flags — M01 · M34 · `Use Work Queue`
[spec](../screens/admin/WARDENX_UI_FEATURE_FLAGS.md)
```
Design "Feature Flags" for WardenX. Work Queue — flags table (key, scope, state on/off/percent,
owner) | Right (flag detail · rollout · audit). SYSTEMS: flag changes audited; degraded features
note. VARIANTS: flags list · flag detail · rollout · dark.
```

### 4.6 Audit Log Viewer — M04 · `Use Work Queue`
[spec](../screens/admin/WARDENX_UI_AUDIT_LOG_VIEWER.md)
```
Design "Audit Log Viewer" for WardenX. Work Queue — forensic audit table (timestamp, actor, action,
entity, tenant) | Right (event detail, before/after, correlation id mono). SYSTEMS: read-only;
PHI in entries masked; break-glass & step-up events highlighted; §164.528 accounting export.
VARIANTS: audit table · event detail · break-glass-filtered · disclosure-accounting · dark.
```

### 4.7 AI Governance Console — M32 · `Use Work Queue`
[spec](../screens/admin/WARDENX_UI_AI_GOVERNANCE_CONSOLE.md)
```
Design "AI Governance Console" for WardenX. Work Queue — AI output review queue (safety flags:
hallucination/contradiction/PII/dosage), model usage, opt-out/kill-switch controls | Right (output
review: provenance, citation, accept/reject + reason). SYSTEMS: the governance bar lives here;
hard-block categories; HITL feedback log. VARIANTS: review queue · output review · safety-flag ·
kill-switch · analytics · dark.
```

### 4.8 Master Data (MDM) — M40 · `Use Work Queue`
[spec](../screens/admin/WARDENX_UI_MASTER_DATA_MDM.md)
```
Design "Master Data (MDM)" for WardenX. Work Queue — duplicate/merge candidate queue, field-level
merge decisions, NPPES/BAA | Right (merge preview: field-by-field, supervisor approval, 72h
rollback). SYSTEMS: merge = supervisor approval ceremony; merge-redirect; rollback window chip.
VARIANTS: match queue · merge preview · merge-confirm (ceremony) · rollback-window · dark.
```

### 4.9 Terminology Admin — M38 · `Use Work Queue`
[spec](../screens/admin/WARDENX_UI_TERMINOLOGY_ADMIN.md)
```
Design "Terminology Admin" for WardenX. Work Queue — code systems / value sets (FHIR), as-of
resolution, effective dates | Right (value-set detail, version history). VARIANTS: value-sets ·
detail · as-of view · dark.
```

### 4.10 Clinical Content Admin — M38 · M01 · `Use Work Queue`
[spec](../screens/admin/WARDENX_UI_CLINICAL_CONTENT_ADMIN.md)
```
Design "Clinical Content Admin" for WardenX. Work Queue — templates, order sets, protocols,
pathways with effective dates | Right (content detail · version · publish). SYSTEMS: publish =
guarded; version history. VARIANTS: content list · detail · publish · dark.
```

### 4.11 FHIR / Interop API — M28 · `Use Work Queue`
[spec](../screens/admin/WARDENX_UI_FHIR_INTEROP_API.md)
```
Design "FHIR / Interop API" for WardenX. Work Queue — FHIR resource export tool (Patient,
Encounter, Condition, MedicationRequest), API access/keys | Right (resource preview · scopes).
SYSTEMS: export audited; PHI scoped. VARIANTS: resource export · API access · preview · dark.
```

### 4.12 Integration Monitoring — M29 · `Use Work Queue`
[spec](../screens/admin/WARDENX_UI_INTEGRATION_MONITORING.md)
```
Design "Integration Monitoring" for WardenX. Work Queue — interface log (HL7 ADT/ORU/MDM, 837/835/
999/277CA, NCPDP), control numbers mono, match confidence, errors | Right (message detail · retry).
SYSTEMS: errors = error/ALERT; retry controls; endpoint health. VARIANTS: message log · message
detail · error/retry · endpoint-health · dark.
```

### 4.13 Referral Source CRM — M06 · M29 · `Use Work Queue`
[spec](../screens/admin/WARDENX_UI_REFERRAL_SOURCE_CRM.md)
```
Design "Referral Source CRM" for WardenX. Work Queue — referral-source master, contacts, outreach
activity log | Right (source detail · liaison activity · follow-up). VARIANTS: source list · detail ·
activity log · dark.
```

### 4.14 Onboarding Wizard — M34 · `Use Stepper Workflow`
[spec](../screens/admin/WARDENX_UI_ONBOARDING_WIZARD.md)
```
Design "Tenant Onboarding Wizard" for WardenX. Stepper — Context Header over steps (org/CCN/NPI →
locations → roles/users → integrations → go-live checklist) with Gate Stepper + sticky footer.
SYSTEMS: completion gates; go-live = guarded. VARIANTS: each step · go-live checklist · blocked ·
dark.
```

## Platform / Ops (WardenX-internal · apps/admin)

### 4.15 Ops Console — M34 · `Use Admin Console`
[spec](../screens/platform/WARDENX_UI_OPS_CONSOLE.md)
```
Design "WardenX Ops Console" for WardenX-internal operators. Admin Console — Ops Sidebar (domains) |
[Tenant Search + System Overview + Tenant Detail] | Right (risk · support actions). SYSTEMS:
cross-tenant operator surface; all actions audited; degraded-mode aware. VARIANTS: overview ·
tenant detail · system risk · dark.
```

### 4.16 Subscription Billing — M35 · `Use Detail Page`
[spec](../screens/platform/WARDENX_UI_SUBSCRIPTION_BILLING.md)
```
Design "Subscription Billing" for WardenX (tenant-facing SaaS billing). Detail Page — Context
Header over stacked sections (plan, usage/seats, invoices, payment method) + actions. $ tabular-nums.
VARIANTS: subscription overview · invoice detail · plan-change · dark.
```

### 4.17 Support / Impersonation Audit — M34 · `Use Gated Action Flow`
[spec](../screens/platform/WARDENX_UI_SUPPORT_IMPERSONATION_AUDIT.md)
```
Design "Support / Audited Impersonation" for WardenX. Gated Action Flow — Subject Selection →
Reason/Scope → Approval/Controls → Active Session (persistent banner across top) → Audit Log.
SYSTEMS: actor-distinct-from-grantor invariant; persistent ALERT session banner; full audit; this
is the break-glass-adjacent operator flow. VARIANTS: initiate · approval · active-session banner ·
audit log · dark.
```

### 4.18 System Health / Degraded Mode — M01 · M34 · `Use Status Board`
[spec](../screens/platform/WARDENX_UI_SYSTEM_HEALTH_DEGRADED_MODE.md)
```
Design "System Health / Degraded Mode" for WardenX. Status Board — Status Header over a service-card
grid (colored by health-operational/degraded/outage — exact tokens from DESIGN.md §2.4) over
incident timeline + integration status over operational controls (degraded-mode banner toggle).
SYSTEMS: the three health colors must match statusColors in code; controls audited. VARIANTS:
all-operational · degraded · outage · incident detail · dark.
```
