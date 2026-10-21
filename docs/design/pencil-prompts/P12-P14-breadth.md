# Breadth Track (P12–P14) — the missing whole screens for thin modules

The depth track (D1–D6) filled the *sub-view* surface of the existing 97 screens. This **breadth
track** adds the **16 whole screens** that thin/zero-coverage modules still lacked — grounded in
each module spec, deduped against the existing corpus and the depth-track sub-views.

Triggered by the same coverage diagnosis: M12 DoseSpot, M24 Medicaid, and M39 Consent had **no
dedicated screen** (only piggybacked on shared ones), and several flagship modules sat at one
screen. (M15 was already closed by D5's discipline care plans; M25/M27 were already covered, so
they're excluded here.)

> Prepend the [Lantern preamble](./README.md). Reuse the D1–D6 libraries (ceremonies, sensitivity,
> states, sub-view tabs). Each screen's spec lists its `## Pencil Notes` variant frames. Record
> node ids in [`../SCREENS.md`](../SCREENS.md). One `.pen` file per phase; user saves before commit.

| Phase | File | Scope | Screens |
| :-- | :-- | :-- | --: |
| **P12** | `chartwarden-P12-prescribing-consent.pen` | M12 DoseSpot prescribing + M39 staff-side consent | 6 |
| **P13** | `chartwarden-P13-medicaid-revenue.pen` | M24 Medicaid billing + M26 cap settlement | 5 |
| **P14** | `chartwarden-P14-ops-gateway-mdm.pen` | M19 on-call · M20 safety · M21 supply · M28 FHIR · M40 MDM | 5 |

---

## P12 — Prescribing & Consent

### 12.1 DoseSpot Prescriber Roster — M12 · `Admin Hierarchy Layout`
[spec](../screens/clinical/CHARTWARDEN_UI_DOSESPOT_PRESCRIBER_ROSTER.md)
```
Admin Hierarchy (provider tree | prescriber detail | validation). Prescriber enrollment: NPI/DEA/
DoseSpot id, IAL2 identity-proofing status, dea_authorized_schedules, epcs_enabled toggle (Phase-1
feature-flag). Bulk IAL2 enroll. SYSTEMS: EPCS-not-certified renders as a guard chip; DEA masked
(reveal=step-up, D2). VARIANTS: roster · prescriber detail · IAL2-pending · EPCS-off · bulk-enroll.
```

### 12.2 Medication Refill Inbox — M12 · `Work Queue`
[spec](../screens/clinical/CHARTWARDEN_UI_MEDICATION_REFILL_INBOX.md)
```
Work Queue. Pharmacy-initiated refill requests with 72h SLA timer; approve/deny; approval mints a
derived medication_order (preview). SYSTEMS: controlled-substance refill rules gate; C-II shows the
EPCS 2FA ceremony (D1) on approve; deny needs a reason. VARIANTS: queue · refill detail · derived-
order preview · C-II EPCS gate · denied · empty.
```

### 12.3 DoseSpot Transmit / Failure Queue — M12 · `Status Board`
[spec](../screens/clinical/CHARTWARDEN_UI_DOSESPOT_TRANSMIT_QUEUE.md)
```
Status Board. Outbound NewRx transmission monitor: queued_for_transmission → transmitted → ack/nack/
transmission_failed; NACK pharmacy feedback; retry-eligible. SYSTEMS: degraded-mode banner (D3) when
the adapter is down (feature-flag flips, drafts queue); error/ALERT on failures. VARIANTS: board ·
NACK detail · retrying · degraded · all-clear.
```

### 12.4 Consent Record Manager — M39 · `Stepper Workflow`
[spec](../screens/compliance/CHARTWARDEN_UI_CONSENT_RECORD_MANAGER.md)
```
Stepper. Staff-side capture across the 10 consent types: type → grantor/subject identity → scope →
capture method (e-signature / uploaded PDF / witnessed-verbal) → effective/expiration → sign & publish
(append-only, versioned, supersession chain). SYSTEMS: 42 CFR Part 2 release renders sealed-by-default
(D2); signature ceremony (D1); AI-prohibited on consent state. VARIANTS: each step · verbal-witness ·
supersede-existing · published.
```

### 12.5 Consent Recipients & DPOA Agents — M39 · `Detail Page`
[spec](../screens/compliance/CHARTWARDEN_UI_CONSENT_RECIPIENTS_DPOA.md)
```
Detail Page. Per-recipient grants (42 CFR Part 2 / HIPAA release / family-caregiver access scope) +
DPOA agent roster (primary/alternates, activation condition, scope, term). SYSTEMS: delegated_access
projection; recipient grant is the consent gate enforced elsewhere; masking on identifiers. VARIANTS:
recipients list · add-recipient · DPOA matrix · activated-alternate · revoked.
```

### 12.6 Consent Expiration & Renewal — M39 · `Dashboard`
[spec](../screens/compliance/CHARTWARDEN_UI_CONSENT_EXPIRATION_RENEWAL.md)
```
Dashboard. Expiring consents color-coded by urgency (90/30/14/7/1-day); renewal-cycle status; re-
capture trigger; M36 alert-delivery status. SYSTEMS: deadline chips; tabular-nums. VARIANTS: dashboard
· urgency cohorts · renewal-in-progress · delivery-failed · empty (all current).
```

---

## P13 — Medicaid & Cap Settlement

### 13.1 Medicaid R&B Arrangement Manager — M24 · `Admin Hierarchy Layout`
[spec](../screens/revenue/CHARTWARDEN_UI_MEDICAID_RB_ARRANGEMENT.md)
```
Admin Hierarchy (facility/arrangement tree | contract detail | per-diem rates). Room & Board for NF/
SNF-resident hospice patients: rb_arrangement contract (per-LOC per-diem, pass-through/retention %
sum-to-100, effective dates, contract doc link) + rb_day per-service-date tracking. tabular-nums;
deadline chips. VARIANTS: arrangements · contract detail · rate editor · expiring · rb_day ledger.
```

### 13.2 Medicaid Eligibility & MCO Routing — M24 · `Gated Action Flow`
[spec](../screens/revenue/CHARTWARDEN_UI_MEDICAID_ELIGIBILITY_MCO.md)
```
Gated Action Flow. Query state Medicaid eligibility (30-day freshness), resolve state Recipient ID,
cache MCO/CCO assignment, auto-detect submission channel (CCO clearinghouse vs direct MMIS). SYSTEMS:
cache-age chip + refresh; Recipient ID masked, never persisted raw; degraded if state portal down.
VARIANTS: pre-check · querying · eligible+MCO · ineligible · stale-cache · portal-down.
```

### 13.3 Medicaid Trading-Partner Credentials — M24 · `Admin Settings Layout`
[spec](../screens/revenue/CHARTWARDEN_UI_MEDICAID_TRADING_PARTNER_CREDS.md)
```
Admin Settings. Per-ProviderEntity per-state per-channel submission credentials (client_secret KMS-
wrapped, masked display); active/inactive; rotation date. SYSTEMS: secret reveal = step-up (D1/D2);
M34 onboarding wizard completion signal. VARIANTS: credential list · add-channel · masked-secret ·
rotate · inactive.
```

### 13.4 Medicaid Validation Override — M24 · `Work Queue`
[spec](../screens/revenue/CHARTWARDEN_UI_MEDICAID_VALIDATION_OVERRIDE.md)
```
Work Queue. Failed-rule overrides on rejected Medicaid claims: failed rules + explain-why, ≥40-char
override reason, elevated-role step-up gate, audit signature. SYSTEMS: override is a Guardrail gate
(D1); blocked until reason + role + step-up. VARIANTS: queue · claim+rules · override form · gated ·
approved · denied.
```

### 13.5 Cap Year Close & Settlement — M26 · `Stepper Workflow`
[spec](../screens/revenue/CHARTWARDEN_UI_CAP_SETTLEMENT.md)
```
Stepper (the cap-year CLOSE workflow; monitoring stays in the existing Cap Management dashboard).
Reconcile PS&R → compute aggregate-cap overpayment/refund → self-report to MAC → settlement proposal
sign-off. SYSTEMS: settlement sign-off blocker (zero open PS&R variances + reviewed + step-up);
tabular-nums; PS&R-window deadline chips; AI-prohibited on the math. VARIANTS: reconcile · compute ·
self-report · sign-off · settled · blocked-variances.
```

---

## P14 — Ops, Gateway & MDM

### 14.1 On-Call Roster & Protocols — M19 · `Work Queue`
[spec](../screens/clinical/CHARTWARDEN_UI_ONCALL_ROSTER_PROTOCOLS.md)
```
Work Queue. The on-call ROSTER + shift schedule + triage-protocol/escalation management (distinct
from the live On-Call Triage call screen): coverage calendar, coverage-gap alerts, protocol library
(platform floor + tenant customization), escalation-tier editor, on-call metrics. SYSTEMS: locked
escalation triggers render as guard chips; AI protocol suggestion advisory-only. VARIANTS: roster ·
coverage-gap · protocol library · escalation editor · metrics.
```

### 14.2 Field Staff Safety Incidents — M20 · `Work Queue`
[spec](../screens/clinical/CHARTWARDEN_UI_FIELD_SAFETY_INCIDENTS.md)
```
Work Queue. Report/track/remediate field safety incidents (assault, threat, unsafe environment,
injury) per staff+location: incident log, type/severity, witness, remediation action, management
acknowledgment, trend view. SYSTEMS: severity ALERT-coded; acknowledgment is a sign step. VARIANTS:
log · new incident · investigation · acknowledged · trend · empty.
```

### 14.3 Supply & DME Inventory — M21 · `Work Queue`
[spec](../screens/clinical/CHARTWARDEN_UI_SUPPLY_DME_INVENTORY.md)
```
Work Queue. Physical supply + DME inventory/replenishment (distinct from the patient-facing Supplies
screen): on-hand stock by category, low-stock reorder, DME equipment tracker (serial #, maintenance
due, battery), supply-transaction ledger. SYSTEMS: low-stock = warning chips; reorder is a gated
action. VARIANTS: inventory · low-stock · DME tracker · maintenance-due · transaction ledger.
```

### 14.4 FHIR Gateway & Client Management — M28 · `Admin Settings Layout`
[spec](../screens/admin/CHARTWARDEN_UI_FHIR_GATEWAY_CLIENTS.md)
```
Admin Settings. SMART OAuth client management + FHIR API monitoring (distinct from the FHIR Interop
API reference screen): client registration (app, redirect URI, scopes, rate limits), active clients,
API metrics (req/min, error rate, top endpoints), consent-gated disclosure logs (per recipient class),
deprecated-version sunsetting. SYSTEMS: consent-gated disclosure (D2 + M39); BAA/scope-mismatch guard.
VARIANTS: clients · register · metrics · disclosure log · sunsetting · scope-blocked.
```

### 14.5 MDM Health Check & Sync — M40 · `Status Board`
[spec](../screens/admin/CHARTWARDEN_UI_MDM_HEALTH_SYNC.md)
```
Status Board. Master-data sync HEALTH (distinct from the golden-record MDM screen): per-category last-
sync (providers/facilities/pharmacies/payers/rate-schedules), NPI/DEA/NCPDP lookup success/failure
rates, duplicate-candidate report + manual-merge, sync-failure alert + retry. SYSTEMS: failure ALERT;
merge is a destructive-confirm (D1). VARIANTS: board · category drill · duplicates · merge-confirm ·
sync-failed · all-healthy.
```
