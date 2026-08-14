# WARDENX_UI_BAA_MANAGER

Version: 1.0
Status: Screen Specification
Module: PRIVACY (M40, M34)

---

## Purpose

The Business Associate Agreement register: every vendor, clearinghouse, and subcontractor that
creates, receives, maintains, or transmits PHI on the agency's behalf, with its signed BAA,
effective/review dates, subcontractor chain, and **BAA status** — which gates whether PHI may
flow to that vendor at all (§164.502(e), §164.504(e)). It is the control plane behind the
platform-wide BAA gate (the M40 `BaaStatusProvider`) that other modules consult before
disclosing PHI to an external party.

---

## Primary Users

- Compliance / Privacy Officer
- Administrator
- Vendor / Contract Manager
- WardenX Ops (platform vendors)

---

## Layout Pattern

Use Work Queue.

```text
Page Header
KPI Strip (active BAAs · expiring ≤90d · missing/blocked · subcontractors)
Filter Bar (vendor · status · service type · review date · PHI access)
Vendor / BAA Table  |  Right Detail Panel
```

---

## Table Columns

- Vendor / business associate
- Service type (clearinghouse, EVV aggregator, e-prescribing, hosting, lab, …)
- PHI access scope
- BAA status
- Effective date · **review-date countdown chip**
- Subcontractors (count)

---

## Detail Panel

- Vendor identity (legal name, NPPES/NPI where applicable, contacts)
- Signed BAA document(s), version history, amendments
- Effective / expiration / next-review dates
- PHI categories shared + minimum-necessary scope
- **Subcontractor chain** — downstream BAAs the vendor must hold
- Linked integrations / data flows that depend on this BAA
- Audit trail of status changes and document uploads

---

## Statuses

`Draft` → `Sent for signature` → `Active` → `Expiring` → `Expired` / `Terminated` /
`Blocked (no valid BAA)`. Only `Active` (and `Expiring`) permit PHI flow; `Blocked`/`Expired`
make the BAA gate **deny**.

---

## Edit Rules & Sensitive Data

- Requires `mdm.baa.manage` (the registered M40 key; there is no `privacy.baa.*` family); activating/terminating a BAA is step-up + audited.
- The BAA status here is authoritative for the platform **BAA gate**: integrations and
  document signed-URL mints check it before releasing PHI to a vendor — a non-active status
  surfaces a Guard Chip ("No active BAA — PHI flow blocked →") at the consuming surface.
- **Review-date countdown chip** drives proactive renewal (neutral → warning at 90/30 days →
  error past due).
- Subcontractor BAAs are tracked but a missing downstream BAA flags the parent as at-risk.
- BAA documents may contain confidential terms; access is permission-gated and audited.

---

## Actions

- Add vendor / draft BAA
- Upload signed BAA / amendment
- Activate · renew · terminate (step-up)
- Record subcontractor + its BAA
- View dependent integrations / data flows
- Export BAA register (for audit/survey)

---

## Empty State

No vendors registered: "No business associates on file" with an "Add a vendor" affordance;
KPI strip zeros.

---

## Pencil Notes

Create versions for:

- Vendor detail with version-history of the signed BAA
- **Review-date countdown chip** at 90-day warning and past-due (error)
- A `Blocked`/`Expired` vendor showing the **Guard Chip** that denies the BAA gate downstream
- Subcontractor-chain expansion with a missing-downstream-BAA flag
- Activate/terminate as a **signature ceremony** with step-up
- BAA register export preview
