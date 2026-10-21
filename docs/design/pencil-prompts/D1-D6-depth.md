# Depth Track (D1–D6) — building the sub-view / variant surface

The 97 top-level screens are each built as **one frame**. But the specs declare ~6.35 frames each
(sub-views, tabs, stepper steps, and the `Pencil Notes` variant/state lists) → a **~600-frame**
true surface, of which ~500 are unbuilt. This track builds that surface.

**Strategy: leverage, not brute force.** Most depth is cross-cutting. We build the reusable
treatments **once** (D1 ceremonies, D2 sensitivity, D3 universal states) as component sets +
showcase boards, then the per-screen expansions (D4 steppers, D5 role/discipline variants, D6
heavyweight sub-views) **instance** them. This collapses hundreds of per-screen frames into a
small symbol set + targeted instances.

> Prepend the [Lantern preamble](./README.md). Reuse the existing component libraries. Record
> built frame node ids in [`../SCREENS.md`](../SCREENS.md) under the Depth-track ledger.
> Cadence: one `.pen` file per phase, opened in Pencil.app; user saves (Cmd+S) before each commit.

| Phase | File | Theme | Frames (≈) |
| :-- | :-- | :-- | --: |
| **D1** | `chartwarden-D1-ceremonies.pen` | Guardrail & signing-ceremony library + showcase | 40 |
| **D2** | `chartwarden-D2-sensitivity.pen` | PHI masking / SUD-Part2 sealing / consent / break-glass states | 30 |
| **D3** | `chartwarden-D3-states.pen` | Universal empty / loading / error / no-permission / zero-after-filter, per pattern | 40 |
| **D4** | `chartwarden-D4-steppers.pen` | Multi-step workflows — all steps (only step 1 exists today) | 70 |
| **D5** | `chartwarden-D5-variants.pen` | Role dashboards (7), discipline care plans (4), assessment instruments, status variants | 90 |
| **D6** | `chartwarden-D6-subviews.pen` | Heavyweight screens' secondary tabs / panels / workspaces | 130 |

---

### D1 — Guardrail & ceremony library · `component set + showcase board`
Reusable blocking/ceremony treatments referenced across dozens of screens. Build as components,
then a showcase board demonstrating each state.
```
- Guard-blocked action: disabled control + reason chip + "why" popover (never silent).
- Signature ceremony: identity confirm → attestation text → sign; states: ready / signing /
  signed / failed.
- Step-up auth ceremony (re-auth for sensitive action): password/MFA prompt → granted / denied.
- EPCS 2FA ceremony (controlled substances): hard-token vs soft-token vs biometric variants;
  privilege-mismatch blocker; DEA-masked-vs-revealed.
- Cosignature flow: pending → cosigner review → cosigned; SLA countdown chip.
- Witness flow (eMAR controlled-substance / waste): witness select → dual-attest → recorded.
- Destructive-action confirm dialog (eraser/void/delete) with typed confirmation.
SYSTEMS: every blocked path shows a reason; ceremonies are modal, focus-trapped, audited.
```

### D2 — Sensitivity & consent states · `component set + showcase board`
The "renders as gated, never blank" treatments.
```
- PHI field mask↔reveal: SSN / MBI / DEA / bank — masked default + "reveal (audited)" step-up.
- SUD / 42 CFR Part 2: sealed card → consent-gate → break-glass justification → revealed (audited).
- Consent gate on a section: "consent required" overlay + request-consent / break-glass.
- Minimum-necessary redaction in previews (document/note) by discipline scope.
- Sensitive-row badges in tables (Part 2 / minor / VIP / employee-record).
SYSTEMS: masking is the default render; every reveal is a logged event with a reason.
```

### D3 — Universal states · `pattern-level templates`
Empty / loading / error / no-permission / zero-after-filter for each high-traffic pattern
(Work Queue, Patient Workspace, Dashboard, Portal Dashboard, Stepper, Document Viewer).
```
Per pattern, one frame each of: loading (skeleton), empty (first-run, with primary CTA),
zero-after-filter (clear-filters affordance), error (retry + support), no-permission (request-
access, never a blank 403), degraded-mode (read-only banner when a dependency is down).
SYSTEMS: errors are actionable; no-permission explains who to ask; degraded-mode is explicit.
```

### D4 — Steppers expanded · `all workflow steps`
Build every step of the multi-step workflows where only step 1 exists.
```
- Admissions / Referral Intake (M06): 8 steps — referral → demographics/payer → document review
  → eligibility → clinical summary → admit prep → consents → confirm.
- Certification / Recert Lifecycle (M06): recert dashboard → assessment → narrative (AI draft) →
  LOC segment → benefit-period → F2F → physician CTI.
- Election & Certification (M06): election statement → benefit period → cert → attestations.
- Death & Pronouncement (M06·M16): pronouncement → notifications → disposition → bereavement enroll.
- Discharge / Revocation / Transfer (M06): reason → effective date → NOTR → final claim handoff.
- Onboarding Wizard (M34): org → locations → providers → users/roles → integrations → go-live.
Each step: its form + the Guardrail blocker when a prerequisite is unmet (reuse D1).
```

### D5 — Role & discipline variants · `template variants`
One template, many frames.
```
- Role dashboards (M33): 7 — Medical Director, Billing Manager, Bereavement Coordinator,
  Scheduler/Dispatcher, QA Officer, Compliance Officer, Intake Coordinator (3 built; build 4+).
- Discipline care plans (M07·M15): Master IPOC + Aide POC + MSW psychosocial + Spiritual care +
  Volunteer plan; review-overdue + IDG-revision variants.
- Clinical assessment instruments (M09): PPS / FAST / PAINAD / ESAS-r / Karnofsky / RASS /
  spiritual / respiratory — entry + scored + trend per instrument.
- Patient-chart lifecycle variants (M05): active / just-admitted / discharged / deceased / merged.
- MAR grid states (M13): scheduled / given / held / refused / PRN / comfort-kit / missed.
```

### D6 — Heavyweight sub-views · `secondary tabs / panels`
The secondary workspaces inside the big screens (only the primary tab exists today).
```
- Patient Chart (M05): allergies / problems / meds / docs / timeline / financial sub-tabs.
- Medications & eMAR (M12·M13): med list · prescribe/eRx · reconciliation worksheet · PRN
  reassessment · comfort-kit drawdown.
- Claims & Billing (M23·M24): AR dashboard · claim workbench · NOE/NOTR queues · claim editor ·
  Medicaid R&B.
- Clinical Note Lifecycle (M08): unsigned queue · version history · side-by-side compare ·
  amendment workspace · forensic audit trail.
- IDG Meeting (M14): agenda builder · live quorate · per-patient packet · minutes/adjournment ·
  decision-application queue.
- HQRP Quality (M30): per-measure detail · CAHPS · QAPI kanban · survey-readiness · incidents.
- Scheduling (M17) / EVV (M18): route optimization · discrepancy queue · caseload view.
```
