# WARDENX_UI_REFERRAL_SOURCE_CRM

Version: 1.0
Status: Screen Specification
Module: Referral Source CRM / Community Liaison (M06 + M40 + M33)

---

## Purpose

The Referral Source CRM is the business-development surface: manage referring facilities and
physicians, track the referral pipeline and conversion, and log community-liaison activity —
the top-of-funnel complement to the clinical Admissions / Referral Intake screen.

---

## Primary Users

- Community Liaison / Marketing
- Administrator
- Intake Supervisor
- Director of Clinical Services

---

## Layout Pattern

Use Work Queue.

```text
Page Header (view: Sources · Pipeline · Activity)
Filter Bar (type · territory · owner)
Source List  |  Right: Source Detail / Referrals / Conversion
```

---

## Sources

Referral sources from MDM (M40 `ReferralSource`): hospital, SNF, ALF, physician/practice,
community. Each: contacts, territory, assigned liaison, BAA status, and referral history.

---

## Source Detail

- Referral history (received → triaged → accepted/declined → admitted)
- Conversion rate and time-to-admit
- Decline reasons
- Liaison activity log (visits / touchpoints) and follow-up tasks
- Contacts and relationship notes (MDM overlay)

---

## Pipeline & Analytics

- Referral pipeline by source and status, with conversion %.
- Top sources, conversion trends, declines by reason, volume by territory.
- Links to the underlying referral records (Admissions / Referral Intake) and the canonical
  source (MDM).

---

## Statuses

- Referral pipeline: `Received`, `Triaged`, `Accepted`, `Declined`, `Admitted`.
- Liaison task: `Open`, `In Progress`, `Completed`.

---

## Empty State

"No referral sources yet." → Add Source. Pipeline: "No referrals in this period."

---

## Actions

- Add / edit source · assign liaison
- Log liaison activity · schedule follow-up
- View pipeline / conversion
- Open referral record
- Export

---

## Pencil Notes

Create versions for:

- Source list (by territory)
- Source detail (conversion + history)
- Referral pipeline
- Liaison activity log
- Conversion analytics
