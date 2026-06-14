# WARDENX_UI_CLINICAL_CONTENT_ADMIN

Version: 1.0
Status: Screen Specification
Module: Clinical Content Administration (M08 / M09 / M11)

---

## Purpose

Clinical Content Administration manages the configurable content behind clinical screens:
note (HearthNote) templates, assessment instruments and their tenant policies/licenses, and
order-set / standing-order templates. It is how an organization tunes documentation without
code changes.

---

## Primary Users

- Org Admin (policy and license write)
- Compliance Officer (read, license registry)
- Clinical Content Steward

---

## Layout Pattern

Use Work Queue.

```text
Page Header (tabs: Note Templates · Assessment Instruments · Order Sets)
Filter Bar
Catalog Table  |  Right: Detail / Versions / Policy / Where-Used
```

---

## Note Templates

HearthNote templates keyed by `template_key` (e.g. `rn_routine_visit_v3`) and
`template_version`, scoped per encounter type × discipline. Show version history and which
encounter types use each.

---

## Assessment Instruments

The instrument catalog is a **platform-fixed, versioned** set of 14 scales: PPS, KPS, FAST,
PAINAD, FLACC, ESAS-r, NYHA, MELD, BODE, Flacker, GDS, Braden, Morse, AIMS. Items, scoring,
and LOINC bindings ship with the platform.

Tenants configure (not the items, but):
- **Scale policy** — `enabled`, significant-change-threshold overrides, reassessment-cadence
  overrides (tighten-only against platform floors).
- **Scale license** — for license-required scales (PPS, FAST, GDS, Braden, Morse): status
  `Active` / `Pending Renewal` / `Expired`; an expired/missing license disables the scale at
  form render.

---

## Order Sets / Standing Orders

Standing-order templates (kinds: lab, supply, ancillary service) with cadence; the template
carries a one-time signature and spawns instances without re-signing.

---

## Statuses

- Assessment capture row: `Active`, `Superseded` (correction chain).
- Scale license: `Active`, `Pending Renewal`, `Expired`.
- Standing order: `Active`, `Paused`, `Expired`, `Discontinued`.

> Instrument *definitions* have no draft/retire lifecycle here — they are platform-managed;
> tenants version only their policy overrides and licenses.

---

## Where-Used & Activation

Each content item shows where it is used (encounter types, completion rates) and its
activation/effective state. Enabling a scale or activating an order-set template takes effect
at the next render.

---

## Empty State

Per tab: "No tenant overrides yet — platform defaults apply." with a Configure entry.

---

## Actions

- Enable / disable scale
- Edit significant-change / cadence overrides (floor-enforced)
- Register / renew scale license
- View note-template versions
- Manage order-set template (sign)
- View where-used

---

## Pencil Notes

Create versions for:

- Note-template catalog + versions
- Assessment instrument catalog (platform-fixed)
- Scale policy override editor (floor-enforced)
- License registry (expiring)
- Order-set template
