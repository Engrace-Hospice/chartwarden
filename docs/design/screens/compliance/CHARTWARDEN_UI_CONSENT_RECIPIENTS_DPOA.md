# CHARTWARDEN_UI_CONSENT_RECIPIENTS_DPOA

Version: 1.0
Status: Screen Specification
Module: Consent Recipients & DPOA Agents (M39)

---

## Purpose

The detail surface for a single patient's **per-recipient consent grants** and **DPOA agent
roster**. It shows the named recipients enumerated on per-recipient consent types
(`42_cfr_part_2_release`, `hipaa_release`, `family_caregiver_access`, `research_participation`)
— each a `consent_record_recipient` row with an M40 entity reference, a purpose-limitation
code, and a per-recipient expiration — and the `consent_record_dpoa_agent` roster (primary +
alternates) with each agent's activation condition, scope, and term. A recipient can be added
incrementally without re-signing as long as the consent scope hasn't materially changed.

---

## Primary Users

- Compliance / Privacy Officer
- Care-team lead / RN (DPOA agent reference for care decisions)
- Admissions staff (recipient and agent capture at admission)

---

## Layout Pattern

Use Detail Page.

```text
Context Header (patient · consent records on file)
Section: Per-recipient consent grants
Section: DPOA agent roster (primary / alternates)
Section: Activation, scope & term
Actions (add recipient · add/replace agent · revoke)
```

---

## Section A — Per-recipient Consent Grants

For each per-recipient consent record, a recipient table:

- Recipient (M40 entity: hospital / specialty pharmacy / research IRB / family member /
  attorney) · **recipient id / NPI** in IBM Plex Mono
- Recipient kind · purpose code (HL7 v3 ActReason) + purpose free-text
- Consent type (`42_cfr_part_2_release` · `hipaa_release` · `family_caregiver_access` ·
  `research_participation`)
- Per-recipient `expires_at` · added-by / added-at · removed-at (if revoked)

A **42 CFR Part 2 release** recipient row carries the §2.32 re-disclosure notice marker and is
sealed/masked until an evaluation against the requesting context passes.

---

## Section B — DPOA Agent Roster

For `dpoa_healthcare` / `dpoa_financial` records, the `consent_record_dpoa_agent` rows:

- Agent kind (`primary` · `alternate_1` · `alternate_2`)
- Agent name · relationship · contact · optional external-physician id (M40 NPI, IBM Plex Mono)
- Removed-at (if superseded)

---

## Section C — Activation, Scope & Term

Per agent:

- **Activation condition** — `immediate` · `upon-incapacity` · `upon-physician-determination` ·
  `upon-incompetence-court-order`
- **Scope** — `healthcare` · `end-of-life` · `financial-narrow` · `financial-broad`
- **Term** — `indefinite` · `until-date` · `event-driven` (with `term_until`)
- `dpoa_active` predicate readout for the current context

---

## Family-caregiver Access Scope

`family_caregiver_access` recipients drive the `delegated_access` projection (one row per named
family member + scope) that the portal session-minter consults. Shows scope, effective window,
portal-session class, and `survives_death` (whether the grant persists into bereavement).

---

## Actions

- Add recipient to an existing per-recipient consent (no re-sign if scope unchanged; a material
  scope change forces a new consent record)
- Add / replace / reorder DPOA agents (primary ↔ alternate)
- Revoke a recipient or a consent record (cascades per the typed revocation handlers)

---

## Guardrails

- **Add-recipient blocked** when the addition is a material scope change — requires a new
  consent record instead.
- **DPOA edit blocked** by self-referential validation — a DPOA record cannot be signed by its
  own future agent; primary/alternate ordering is validated.
- Revoking a DPOA agent re-routes signing authority back to patient or the next alternate
  (cascade); revoking a recipient narrows future disclosures within seconds.
- Step-up (`consent_management`) required for any mutation; all actions audited.

---

## Provenance & Sensitivity

- **AI-prohibited.** No AI may add recipients, appoint agents, or evaluate/override consent
  (`validateM39AIBlock` *(target — not yet implemented; the built sibling is `validateSupplyAIBlock`)*).
- Recipient NPIs, external-physician NPIs, and consent record ids render in IBM Plex Mono.
- Part 2 recipient rows are sealed/masked until the consent gate passes; the §2.32 notice marker
  is shown on every Part 2 grant.

---

## Empty State

No recipients / no DPOA agents on file: "No named recipients on this consent" and "No DPOA
agents recorded" with add affordances; for a patient with no per-recipient consents, a prompt to
capture one in the Consent Record Manager.

---

## Pencil Notes

Create versions for:

- Recipients populated — `hipaa_release` + `42_cfr_part_2_release` recipient tables (Part 2 sealed)
- DPOA roster — primary + two alternates with activation/scope/term
- Add-recipient — incremental add (no re-sign) vs material-change **blocked** guardrail
- DPOA self-referential validation **blocked**
- Revoke recipient / agent — cascade + authority re-route confirmation
- Family-caregiver `delegated_access` scope with `survives_death`
- Empty state — no recipients / no agents
- Loading; no-permission (read-only, mutations hidden)
