# CHARTWARDEN_UI_CONSENT_RECORD_MANAGER

Version: 1.0
Status: Screen Specification
Module: Consent Record Manager (M39)

---

## Purpose

The staff-side surface for **capturing a new consent record** across the ten platform consent
types. A compliance officer or clinician walks a guided capture flow: pick the consent type,
choose the capture method (e-signature / typed-in-app / uploaded signed PDF / witnessed-verbal /
notarized), establish the grantor's identity and authority, define the scope, set the
effective and expiration dates, then sign and publish. Publication is **append-only and
versioned** — every consent record is one execution row; an edit creates a new row pointing at
the prior via `supersedes_consent_record_id`, and the M22 `consent_record` template renders the
signed PDF.

---

## Primary Users

- Compliance / Privacy Officer
- Admissions / Intake staff (capture at admission)
- RN / MSW (witnessed capture in the field, per scope)

---

## Layout Pattern

Use Stepper Workflow.

```text
Context Header (patient · consent type · capture method)
Left Nav Rail (Steps)  |  Center Workspace (current step)  |  Right: scope / authority context
Sticky Footer Actions (Back · Save Draft · Next · Sign & Publish)
```

---

## Steps

1. **Consent type** — pick from the eleven platform types (+ `custom`; the enum includes `bereavement_outreach_consent`, which drives the M16 outreach gate) (`portal_access`, `dpoa_healthcare`,
   `dpoa_financial`, `family_caregiver_access`, `42_cfr_part_2_release`, `media_release`,
   `research_participation`, `telehealth_consent`, `advance_directive_acknowledgment`,
   `hipaa_release`) plus any tenant custom type. Type selection drives the scope schema and the
   platform-floor capture / expiration / reminder policy.
2. **Capture method** — `electronic_portal_signature` · `typed_signature_in_app` ·
   `uploaded_signed_pdf` · `witnessed_verbal_documented` · `notarized`. The selectable set is
   constrained to the type's `capture_method_floor` (tenant may tighten, never loosen).
3. **Grantor & subject identity** — patient (subject) resolved via PatientReader; grantor with
   `grantor_kind` (`patient_self`, `dpoa_healthcare_agent`, `court_guardian`,
   `parent_for_minor`, `healthcare_surrogate`, …). Non-self grantors require `acting_consent_id`
   proving authority; self-referential validation blocks a DPOA signed by its own future agent.
4. **Scope** — the TypeBox scope descriptor bound to the type (categorical / per-recipient /
   per-named-agent / per-encounter); per-recipient types collect named recipients.
5. **Effective & expiration dates** — `effective_at ≤ now()` (no future-dated signatures);
   `expires_at > effective_at` and within the type's term ceiling (e.g. `42_cfr_part_2_release`
   1 year, `hipaa_release` 6 months, `dpoa_healthcare` indefinite).
6. **Review & evidence** — capture-method evidence (typed signature / uploaded PDF / notary
   certificate doc ref / witness name + attestation ≥20 chars + witness signature doc ref).
7. **Sign & publish** — commit the `active` consent record; emit `m39.consent.signed`; M22
   renders the `consent_record` PDF; the back-ref stamps `consent_document_link`.

---

## Per-step State

- Per step: not-started / in-progress / complete / blocked.
- Screen-level: validation-failed (scope schema mismatch, authority unproven, date out of range).
- Draft state has no regulatory force (`signed_at` NULL); drafts auto-expire after 30 days as a
  housekeeping TTL, not a retention commitment.

---

## Guardrails

- **Sign & Publish blocked** until the scope descriptor conforms to the type's TypeBox schema
  and the grantor's authority is proven (`acting_consent_id` present and valid for non-self).
- **Capture method blocked** if outside the type's floor; `notarized` requires a notary
  certificate doc ref; `witnessed_verbal_documented` requires witness name + attestation +
  witness signature doc (last-resort, AD / code-status only with documented incapacity).
- **`bereavement_outreach_consent`** is captured post-death only with `grantor_kind=
  bereaved_person_self` (handled on the bereavement surface, not here).
- Staff-side consent management requires the `consent_management` step-up profile; every action
  is audited.

---

## Provenance & Sensitivity

- **AI-prohibited.** No AI may create, modify, evaluate, or revoke a consent record
  (`validateM39AIBlock` *(target — not yet implemented; the built sibling is `validateSupplyAIBlock`)*, AI Governance §2.1.4) — the stepper accepts only human input.
- `42_cfr_part_2_release` captures carry the §2.32 prohibition-on-re-disclosure notice into the
  rendered PDF; SUD-context scope is sealed/masked elsewhere until an evaluation passes.
- Consent record id and recipient NPIs render in IBM Plex Mono.

---

## Permissions

- `consent.author`, `consent.sign` for capture and publication; `consent.read` for review.

---

## Empty State

Entering the manager with no in-progress capture: "Start a new consent record" with the consent
type picker; a list of recent drafts for this patient (resumable) shown alongside.

---

## Pencil Notes

Create versions for:

- Step 1 active — consent type picker (ten types + custom slot)
- Capture-method step — floor-constrained options; **notarized** evidence requirement
- Grantor/authority step — non-self grantor needing `acting_consent_id` (chain-of-authority)
- Scope step — per-recipient `42_cfr_part_2_release` with recipient enumeration
- Dates step — effective/expiration with term-ceiling validation
- Sign & Publish — review + signature evidence, append-only/version note
- Validation-failed — scope schema mismatch / authority unproven (blocked)
- Empty/loading; no-permission (capture disabled without `consent.author`)
