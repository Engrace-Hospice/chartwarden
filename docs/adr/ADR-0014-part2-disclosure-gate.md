# ADR-0014 — 42 CFR Part 2: gate disclosure not creation; persist-after-redact at ingress; enforced re-disclosure

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 3 (governed subsystems)
- **Resolves:** H2, S11; M29-F03, M39-F05, M09 (AIMS), M06, M19 (re-disclosure)
- **Changes:** `WARDENX_MODULE_29`, `WARDENX_MODULE_39`, and the SUD-touching modules (M05/M06/M09/M19/M28)

## Context

42 CFR Part 2 restricts the **disclosure and re-disclosure** of SUD records — it does **not**
restrict their **creation** by the treating program. The corpus mis-handles this in three ways:

1. **Mis-encoded as a write gate** that blocks mandated clinical documentation (M09 AIMS, M06) —
   the treating program must be able to *create* SUD records; Part 2 governs who they go *to*.
2. **Persist-before-redact at ingress (M29 — BLOCKER S11):** M29 persists every raw MLLP wire byte
   *before* parsing/redaction, while *also* claiming to strip SUD segments "before encryption."
   These are mutually exclusive — as written, raw SUD-bearing bytes land in storage before the
   consent gate runs, defeating the Part 2 ingress gate.
3. **Re-disclosure handled only via retention promotion (M39), with no enforced gate**, and
   re-disclosure to an external triage vendor (M19) without consent/QSOA.

## Decision

### D1 — Part 2 gates DISCLOSURE, never CREATION

The treating program may always **create/document** SUD-related clinical content (AIMS assessments,
admission notes, etc.). Part 2 controls apply at **disclosure/re-disclosure** boundaries. No module
may block mandated clinical documentation on a Part 2 *consent* check (M09/M06 fix). The
`ConsentEvaluator` returns redaction/disclosure decisions at **read/egress** time, fail-closed.

### D2 — Persist-after-redact at ingress (M29)

SUD redaction / consent evaluation runs **before any durable write** of SUD-bearing bytes. The
disclosure-accounting / inbound record stores the **redacted** payload — or **nothing** for a
refused-ingress SUD frame. Raw, unredacted SUD wire bytes **never** land in encrypted-at-rest
storage ahead of the gate. M29 picks one coherent ordering (redact → then persist) and makes
§2.2/§3.3/§8.3 consistent with D15/W-XI-14.

### D3 — Re-disclosure is an enforced gate, not a retention side-effect

Re-disclosure of Part 2 data to any external recipient (triage vendor, HIE, AI vendor) requires a
consent record naming the recipient **or** a QSOA, enforced at the egress boundary (not merely a
retention-class promotion). The M19 external-triage path must carry consent/QSOA or redact. Default
for every PHI-Sensitive category (SUD, HIV, mental health, genetic, family-violence) is
**redact/deny** when no release consent names the recipient.

### D4 — PHI-Sensitive extra controls are enumerated (OPEN-021)

A module handling Part 2 / PHI-Sensitive data defines the extra controls beyond standard PHI:
segmentation (the data is tagged and filterable at query time), consent-directed re-disclosure
restriction, the §2.31 per-recipient grant model, and the redacted-by-default egress. Redaction
flags M39 returns (`redactHiv*`, `redactMentalHealth*`, `redactGenetic*`) must each be backed by a
consent type or an M5 PrivacyFlag that authoritatively drives them — no advisory/ambiguous flags.

## Consequences

- M29 reorders to persist-after-redact (S11 cleared). M39 keeps the fail-closed `evaluateForDisclosure`
  but removes/over-defines the unsupported sensitive-category flags (M39-F05) and enumerates the
  Part 2 extra controls.
- M09/M06 stop gating SUD-record *creation*; the gate moves to disclosure/egress.
- Ties to ADR-0013: a Part 2 disclosure that is permitted still writes a §164.528 accounting record
  (Part 2 disclosures surface as a distinct accounting scope).
