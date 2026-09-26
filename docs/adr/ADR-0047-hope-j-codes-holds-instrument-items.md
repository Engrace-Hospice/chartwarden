# ADR-0047 — `hope_j_codes` holds CMS HOPE **item identifiers**, not J2051 symptom codes

- **Status:** **Accepted** — ratified 2026-08-27. Resolves the open question left by
  [ADR-0046](ADR-0046-d11-vocab-pin-is-the-narrative-corpus.md)'s sibling change, PR #149 (F-057),
  which wired the CMS pre-submission validator and recorded this as unanswered.
- **Date:** 2026-08-27
- **Phase:** production-readiness audit remediation (2026-08-25 corpus).
- **Related:** issues #148 (F-057, the validator that had never run) and #91 (F-031, the M10 capture
  path whose recording modal produces the Section-J payload this rule reads).

## Context

M38 defines the value set `hope_j_codes` — *"HOPE J-code symptom-impact items: J2030, J2050, J2051
plus related; consumed by Module 10"* — and M10's §86 pre-submission rule 3 checks every recorded
"J code" against it. Two different things could be meant by that, and the codebase contained both
readings at once:

1. **The instrument's ITEM identifiers** — `J2030` (screening for pain), `J2050` (screening for
   shortness of breath), `J2051` (symptom impact at this visit). The set's own name and description
   say this, and the rule's comment says transposed codes are corrected against it.
2. **The J2051 SYMPTOM codes** — `pain`, `shortness_of_breath`, `anxiety`, … The `SectionJInput.jCodes`
   doc line read *"The J-item / symptom codes recorded in J2051"*, and the projection written in
   PR #149 followed the second half of that slash: it fed the rule the symptom codes.

The set has no members, so neither reading had ever been exercised. Rule 3 answered
`VALUE_SET_UNAVAILABLE` on every assessment and the ambiguity cost nothing — yet.

## Decision

**`hope_j_codes` holds CMS HOPE item identifiers.** The J2051 symptom codes are excluded from it
permanently, and `sectionJOf` projects the Section-J ITEM keys present in `data.J` rather than the
symptom codes recorded under `J2051`.

To make the set curatable, `code_system_id` gains **`cms_hope`** (migration 0229) and
`PLATFORM_VALUE_SET_MEMBERS` curates the three items M10 spec §2.1 enumerates.

## Rationale

**The symptom reading makes the rule structurally incapable of failing.** As of #151,
`data.J.J2051.entries[].symptomCode` is closed at M10's route boundary to the eight
`HOPE_J2051_SYMPTOM_CODES`; TypeBox rejects anything else with a 400 before the payload is stored.
Checking those values against a value set is a weaker, asynchronous, eventually-consistent copy of a
check the boundary already makes synchronously and absolutely. It could only ever pass — which is the
same defect class as F-029, F-042, F-051 and F-057 itself: a control that can only answer one way, and
therefore tells nobody anything. A rule set is not improved by adding a rule that cannot fire.

**The symptom codes are not terminology.** `HOPE_J2051_SYMPTOM_CODES` is a WardenX-internal
vocabulary defined in `@wardenx/types`. Placing it in a terminology *service* value set would assert
it is externally governed, invite a tenant extension to widen it (M38 permits tenants to ADD to a
platform set), and split its authority across two modules. The instrument's item roster genuinely is
externally governed: CMS publishes it and revises it annually.

**"Transposed" only makes sense for item numbers.** The rule's own comment — M10-F07, *"transposed
codes are corrected against the CMS value set"* — describes transposing the digits of an item number
(`J2050` → `J2005`). Symptom names are not transposed; they are a closed picklist.

**Severity fits.** Rule 3 is a `warning`, not an `error`. "This payload carries a J item CMS does not
recognise" is a data-quality signal worth surfacing without blocking a submission — which is right for
a transposed or newly-decommissioned item, and would be wrong for an invalid answer to a valid
question (that is the boundary's job, and it returns 400).

## Why `cms_hope` is a code system rather than a workaround

`value_set_member.system_id` is the `code_system_id` enum, and none of its eleven values is the
authority that publishes `J2030`. The set was therefore **definable but not curatable**: the only way
to seed a member would have been to assert a false system for it — writing `J2030` as a LOINC code,
which it is not (LOINC's CMS-instrument codes are numeric).

The curation file lists `hope_j_codes` among the sets *"populated once the per-system loaders have
run"*. That reason does not apply to it: there is no HOPE loader to wait for, and the set meets that
same file's stated criterion for inline curation — small, fully enumerated, CMS-public, listed inline
by the spec.

The enum is not a clinical-terminology roster. It already carries `revenue` (NUBC UB-04), `carc` and
`rarc` (X12) — administrative code lists published by a body, exactly what a CMS assessment instrument
is. `cpt` is held out of the union for a **licensing** reason (AMA), stated in `enums.ts`; CMS HOPE
items are public like the other three. No concept table ships for `cms_hope`, which is the norm rather
than an exception: per-system concept tables exist only for the four systems with bespoke property
shapes, and seven of the eleven — `revenue` included — live in the catalog and their value sets
without one.

## Consequences

- Rule 3 can now **fail**, which is the point: an unrecognised or transposed J item warns, and the
  three curated items pass. Both arms are covered in `hope-presubmission-validation.test.ts` against a
  TerminologyProvider registered over the real seed.
- The runner resolves `hope_j_codes` by **expansion** instead of `isMemberOf`, which removes a guessed
  code system (`"loinc"`, an invention of PR #149) and collapses availability and membership into one
  pass so they cannot disagree. `hospice_terminal_diagnosis` keeps `isMemberOf`, because it is
  ICD-10-CM and potentially enormous — the asymmetry is about set size, not semantics.
- A CMS annual update that adds or retires a Section-J item is now a curation change in
  `PLATFORM_VALUE_SET_MEMBERS`, with `member_end` carrying the retirement so an as-of lookup against a
  historical `target_date` still resolves.
- The set's membership is deliberately **not** claimed to be the complete CMS roster. It is the three
  items M10 spec §2.1 enumerates; the description's "plus related" is an invitation to curate more as
  the instrument's Section J is implemented, not an assertion that more are already there.
