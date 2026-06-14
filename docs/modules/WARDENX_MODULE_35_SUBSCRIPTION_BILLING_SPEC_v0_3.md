# WardenX — Module 35 — Subscription Billing — Lock-Grade Spec v0.3

> **Status:** Locked v0.3 — buildable
> **v0.3 change:** outbox events / alert payloads migrated to the `m35.` namespace
> (`m35.subscription.*`, `m35.invoice.*`, `m35.payment_method.*`, `m35.dunning.*`,
> `m35.refund.*`, `m35.promo.*`, `m35.usage.*`, `m35.revenue.*`, `m35.stripe.*`,
> `m35.tenant.billing_blocked`) per M01 D8 / M36 D10 / M03 D9; stray bare event refs aligned.
> Permission keys (`subscription.admin`, `promo.admin`, `refund.approve`, …), schema fields
> (`subscription.status`, `subscription.id`), and Stripe SDK object refs are unchanged. (Prior: v0.2.)
> **Phase boundary (binding):** **Phase 2** (architecture §20.A). Phase 1 ships nothing visible for M35 — Engrace go-live runs unbilled. The lock-grade spec lands in v0.2 so implementation is unblocked the moment the architecture green-lights Phase 2 build, with the proximate trigger being "first paying tenant joins beyond Engrace" (architecture §20.A Phase 2 module list). Forward-seam deny-stubs (§4.5) and the AI-boundary boot gate (§8.8) ship at M35 lock; the rest activates at Phase 2 implementation.
>
> **PHI posture (binding):** **NONE.** M35 never reads, writes, stores, transmits, or transits Protected Health Information. Every metering signal that quantifies patients or users uses an HMAC pseudonym computed inside an M35-private boundary (D6). Stripe sees pseudonyms and aggregate counts; M35's database sees pseudonyms and aggregate counts; M35's audit trail sees pseudonyms and aggregate counts. The patient-identity → pseudonym map exists only in M35's `patient_pseudonym_key` (envelope-encrypted; rotated). The Stripe vendor surface is therefore *not* a BAA-bearing surface (Integrations §6.11), and the STRIDE worst case for an M35 breach is the disclosure of commercial billing counts, never patient identity.

-----

## Changelog

- **v0.3 (Locked)** — Batch-4 cross-module ownership fixes applied.
  **M35-F04 (ADR-0011 / ARCH-147):** All §3.3 schema files that imported `organizations` or
  `memberships` from `packages/db/src/schema` and called `.references(() => organizations.id /
  memberships.id)` are corrected. `organization_id` and membership-id columns are now plain
  `uuid()` columns (logical FKs, RLS-governed); cross-module `.references()` calls removed.
  Affected files: `subscription.ts`, `subscription-state-history.ts`, `payment-method.ts`,
  `invoice.ts`, `invoice-line.ts`, `usage-event.ts`, `usage-period-aggregate.ts`,
  `patient-active-period.ts`, `user-active-period.ts`, `dunning-state.ts`,
  `promo-code-application.ts`, `refund.ts`.
  **M35-F05 (ADR-0144 / ARCH-281#5):** §3.6 reworded. M35 no longer defines its own audit-trigger
  denylist; it registers advisory posture hints with M4's `AuditDenylistRegistry` at boot.
  M4 owns the trigger-suppression decision. §8.4 updated to match.
  **M35-F06 (ARCH-186/085/251):** §3.7 `preserveInvoicesForRetention` in-place org_id rewrite
  replaced by a copy-then-delete transfer to first-class platform-retention tables
  (`platform_retained_invoice`, `platform_retained_invoice_line`). These tables carry
  `original_organization_id` for forensic/regulatory traceability and are declared in
  `M35.ownedTables` (19 → 21 tables). D13, W-SB-13, §8.6, §12.2, and the §13 manifest
  patch updated accordingly. (Prior: v0.2.)
- **v0.2 (Locked)** — Initial publication at lock-grade. Instantiates the architecture §20.B module spec template. Resolves all twenty-four open questions into binding decisions (§11). Defines the **hybrid per-seat + per-patient-month plan model closing ADR-001** (D1) — three platform-owned plan tiers (Starter / Professional / Enterprise) each with included quantities of active patients and active users plus per-meter overage pricing for AI tokens, claim volume, FHIR egress requests, and HL7 message counts; the meter catalog is platform-owned (D11) with no tenant overlay because every meter must map to a Stripe `meter` resource. Defines the **outbox-only Stripe API submission posture** (D3) — every outbound call to the Stripe API is made by the `stripe-dispatcher` BullMQ worker draining the M35 outbox; deterministic Stripe idempotency keys derived from `(operation, businessKey, attempt_index)` mean a retried submission is a no-op at Stripe; mirrors M23 D2 MAC submission and M12 D3 DoseSpot submission. Defines the **webhook handler posture** (D4) — Stripe-Signature HMAC verification against `STRIPE_WEBHOOK_SECRET` at the route boundary, dedup on Stripe event id via `stripe_webhook_event` with 30-day replay protection, envelope-encryption of the payload at rest (D15), and a single outbox emit (`m35.stripe.webhook_received`) that decouples receipt from processing. Defines the **append-only usage-event ledger** (D5) partitioned by month and aggregated into per-period `usage_period_aggregate` rows that are the source of truth for `stripe usage_record` posting; three-level idempotency (`source_event_id` on ingest, aggregate uniqueness on `(org_id, subscription_id, event_type, period)`, `stripe_usage_record_id` on post) means a multi-source replay storm produces correct totals. Defines the **HMAC-pseudonym discipline** (D6) — every per-patient and per-user meter event recorded by M35 stores a pseudonym computed as `HMAC-SHA256(platform_key_id, patient_id_or_membership_id)` with platform-key rotation; the raw patient_id never enters an M35 table; the same patient produces the same pseudonym deterministically within a key epoch so dedup of `active_patient` events works. Defines the **dunning XState v5 lifecycle** (D7) — `current → past_due → at_risk → suspended → canceled` with platform-floor cadences (`day_1 → day_7 → day_14 → day_21 → day_28 (suspend) → day_60 (cancel)`); tenant overrides may *tighten* (suspend sooner) but never *loosen* (suspend later) per the platform-floor / tenant-tighten-only architecture rule. Defines the **AI-prohibited zone for M35** (D8) — Module 32's LLM may not synthesize, modify, or redact subscriptions, invoices, dunning copy, refund decisions, or plan changes; enforced at boot via `validateM35AIBlock()` against M32's prompt registry mirroring M12 D12 / M13 D15 / M22 D-pattern / M28 D14. Defines the **USD-only Phase 1, ISO 4217 platform-floor currency catalog** (D9) sourced from M38 with multi-currency deferred to Phase 3. Defines the **Stripe Tax as the sole tax engine** (D10) — WardenX never computes tax. Defines the **platform-owned plan catalog** with no tenant overlay (D11). Defines the **14-day platform-floor trial** with tenant-tighten allowed and tenant-extend requiring `platform_admin` (D12). Defines the **7-year invoice retention floor** per IRS §6001 with platform-retention-class invoice records that survive tenant offboarding (D13). Defines the **hard PHI boundary** (D14) and the **envelope-encrypted webhook payloads** (D15). Defines the **four-stage refund workflow** with `platform_admin` approval gate (D16). Defines the **platform-ops-only promo-code apply** (D17). Defines the **MRR/ARR monthly snapshot computation** (D18). Defines the **tenant-lifecycle integration via M2 organization outbox events** (D19). Defines the **6 published seams** registered into the M1 seam registry with boot validation (D20). Defines the **outbox subscription catalog** (D21). Defines the **STRIDE map** (D22). Defines the **proposed manifest patch** updating `M35.dependsOn` from the architecture §20 sketch `[34]` to `[1, 2, 3, 4, 5, 28, 29, 32, 36, 38]` *(relationship inventory - not the `dependsOn` edge set; per ADR-0005 D1/D4 seam/outbox/foundation consumers are no-edge - see audit/MANIFEST_DEPENDSON_REVIEW.md; do not bulk-apply)* — the architecture's `[34]` was build-sequence shorthand (M35 ships after M34's tenant infrastructure exists in Phase 2) and not a code-level dependency; the correct direction is M34→M35 (M34 consumes M35's `SubscriptionStateProvider` / `BillingStatusProvider` from its tenant admin console); M35 does not depend on M34 at the code level and instead reads `OrganizationReader` from M2 directly with a forward-seam-deny-stub consumption of `OnboardingStatusProvider` that wires when M34 locks (D23, D24). Populates `M35.ownedTables` with 21 owned tables (updated from the original 19 by M35-F06): 12 tenant-scoped (RLS-enforced, `organization_id`-FK'd) + 5 platform-shared (`plan`, `plan_meter`, `promo_code`, `revenue_recognition_snapshot`, `patient_pseudonym_key`) + 2 platform-only Stripe audit (`stripe_webhook_event`, `stripe_api_call_audit`) + 2 platform-retention (`platform_retained_invoice`, `platform_retained_invoice_line`). Adds `packages/subscription-billing` to `codePaths`.
- **v0.1** — Drafted within the lock-grade pass; not separately published.

-----

## 1. Purpose & Scope

### 1.1 What This Module Does

Module 35 is **WardenX charging its customer agencies** — the SaaS-billing surface for the WardenX product itself, distinct from M23 (Medicare claims) and M24 (Medicaid claims) which are billing surfaces *for the tenant's hospice care*. The name "billing" appears three times in the manifest (M23, M24, M35); only M35 charges WardenX's own customers. The architecture's English ambiguity is corrected at the code boundary: M35 lives in `packages/subscription-billing` and shares zero schema with `packages/billing` (M23) or `packages/medicaid-adapters` (M24); the dependency-cruiser rule (§13.2) asserts non-overlap.

In one paragraph: M35 owns the **plan catalog** (platform-owned, three-tier hybrid model per ADR-001 closing as D1), the **subscription lifecycle** (one subscription per Organization, XState v5 state machine, Stripe-authoritative with WardenX as mirror per D2), the **invoice mirror** (Stripe is authoritative; WardenX mirrors for read paths), the **payment method registry** (Stripe is authoritative; WardenX mirrors metadata only — never card numbers, never bank account numbers, never CVVs), the **usage metering pipeline** (append-only `usage_event` → per-period `usage_period_aggregate` → Stripe `usage_record` API posting), the **dunning state machine** (platform-floor cadences with tenant-tighten allowed per D7), the **refund workflow** (four-stage with `platform_admin` approval per D16), the **promo-code redemption ledger** (platform-ops-only apply per D17), the **MRR/ARR snapshot** (platform-shared aggregate for ops dashboard per D18), the **revenue dashboards** (publishing `RevenueMetricsProvider` to M33 reporting), and the **Stripe webhook ingestion** (HMAC-verified, idempotent, replay-protected per D4 / D15).

The module's value proposition is one binding promise: **WardenX collects revenue from customer agencies without ever seeing PHI in the process.** Patient counts and user counts flow through M35 as HMAC pseudonyms (D6); the raw `patient_id` and `membership_id` never enter an M35 table or a Stripe API payload. A successful Stripe-side data breach exposes commercial billing counts, never patient identity. This is the M35 STRIDE worst-case (§8.3) and it is a structural property of the schema, not a policy promise.

The Phase boundary is binding (per the spec header): M35 ships nothing visible in Phase 1. Engrace operates unbilled during Phase 1 because Engrace is the founding customer and WardenX's commercial relationship with Engrace is governed by a master agreement that pre-dates M35. The M35 build effort begins when the architecture green-lights Phase 2, with the proximate trigger being "first paying tenant joins beyond Engrace" — at that point, Engrace is migrated onto a Stripe Customer record and the first M35 invoice runs.

### 1.2 What This Module Does Not Do

M35 has hard boundaries against adjacent modules. Mis-routing scope into M35 is the most common failure mode and is foreclosed here:

- **M35 is not Medicare or Medicaid claims billing.** That is M23 (Medicare 837I, NOE/NOTR, MAC portals) and M24 (Medicaid 837I, state portals, per-state adapters). M23 and M24 charge CMS / state Medicaid agencies for the tenant's patient care. M35 charges the tenant agency for the WardenX subscription. The dependency-cruiser rule (§13.2) asserts these three modules share no schema and import only published seams.
- **M35 is not the accounting GL.** That is M29 / Xero (Integrations §6.9). M35 emits revenue events via outbox; Xero pulls them through M29's `XeroClientFactory` seam. M35 does not own a chart of accounts, does not compute GAAP revenue recognition (Stripe Revenue Recognition is available as a Phase 3 add-on), and does not journal-entry.
- **M35 is not the cost-report.** That is M27 (CMS-1984-14). M35's revenue is the tenant's *expense*, which only shows up on the tenant's cost report if WardenX subscription fees are administrative overhead deductible against CMS reimbursement — a determination M35 has no opinion on. M27 reads `InvoiceReader` from M35 for the optional "administrative software costs" worksheet line if the tenant's accountant elects to include it.
- **M35 is not Stripe.** Stripe is the authoritative source for Customer / Subscription / Invoice / Charge / Refund / PaymentMethod / UsageRecord / Coupon / PromotionCode. M35 mirrors these for read paths but Stripe wins on conflict (D2). Reconciliation runs hourly (`subscription-reconciler` cron, §4.8) and on every webhook.
- **M35 does not store PHI.** Hard boundary. Every metering signal uses HMAC pseudonyms (D6). The raw patient_id and membership_id never enter an M35 table or an outbound Stripe API payload. There is no exception for any reason; "we need the patient name for the invoice" is wrong — Stripe invoices reference the *Organization* (= tenant = customer agency), not the patient.
- **M35 does not compute tax.** Stripe Tax handles US sales/use tax computation (D10). WardenX never owns the tax rate table, never determines nexus, never files state returns. M35 mirrors Stripe Tax line items on invoices for display only.
- **M35 does not own card data.** Stripe Elements (frontend) tokenizes; the Stripe Payment Method id is all that ever enters M35's database. The `payment_method` table holds card brand + last4 + expiry month/year as Stripe-furnished metadata — never the PAN, never the CVV, never the full IBAN. PCI scope is "SAQ A" by virtue of using Stripe Elements + Payment Element exclusively.
- **M35 does not bill per encounter, per visit, per assessment, or per any clinical artifact.** The meters are *administrative*: active patient (HMAC-pseudonymized count per billing period), active user (HMAC-pseudonymized count per billing period), AI tokens (from M32), claim volume (from M23 + M24), FHIR egress (from M28), HL7 message count (from M29). A Stripe meter is never attached to a clinical event payload.
- **M35 is not the source of "tenant suspended"** — that is M2's `Organization.status` field and the M2 admin surface. M35 *reacts* to `m2.organization.suspended` outbox events by pausing the Stripe subscription, but the suspension decision is M2's. Conversely, M35 reactively suspends *Stripe billing* when M2 suspends the organization for non-billing reasons (compliance, customer request). M35-initiated suspension (dunning day-28) updates `dunning_state` and emits `m35.tenant.billing_blocked`; M34 (when locked) consumes that event to gate feature access.
- **M35 does not own the BAA, the MSA, or the order form.** Those live in M34 (contract catalog) and outside the platform (legal). M35 references the `organization_id` and assumes the legal substrate is in place.

### 1.3 Regulatory & Operational Drivers

M35 sits in an unusual regulatory zone for a HIPAA-bearing platform: M35 itself is *not* a HIPAA Business Associate function with respect to its own data, because M35's data is commercial billing without PHI (D14). But M35 operates inside the WardenX platform which *is* a Business Associate of its customer agencies; so the boundary discipline matters not for HIPAA reasons but for the structural separation it creates. The drivers are:

- **IRS §6001 / Treasury Reg §6001 (record retention)** — invoices and tax records must be retained for the longer of (a) 3 years from filing, (b) 6 years if income is under-reported by ≥25%, or (c) indefinitely for unfiled returns. M35 sets a **7-year platform retention floor on `invoice` and `invoice_line`** (D13) which covers the longest non-fraud case. Tenant offboarding *cryptographically shreds* the patient-pseudonym aggregates but preserves the invoice record (platform retention class, not tenant retention class).
- **PCI DSS (SAQ A)** — by using Stripe Elements + Stripe Payment Element with no card data touching WardenX backend, M35 qualifies for the simplest SAQ. The `payment_method` table holds only Stripe-furnished metadata (brand, last4, exp month/year, payment method id); the full PAN / CVV / IBAN never enters WardenX storage or transit.
- **State sales-tax nexus** — variable per state, computed by Stripe Tax. WardenX has no opinion. The `invoice_line.kind = 'tax'` rows are mirrors.
- **Stripe Terms of Service** — Stripe is a regulated payment processor; WardenX's use of Stripe is governed by Stripe's TOS and the Stripe API contract. Webhook signature verification and idempotency are *Stripe requirements*, not optional best practices. Failure to verify or dedup is grounds for Stripe to suspend the integration.
- **CCPA / GDPR (when international)** — the data subjects of M35 are *organizations* (B2B), not natural persons, with the partial exception of payment method holders (the named cardholder is a natural person whose name appears on the card). Stripe handles the data-subject rights for that data; WardenX exposes a Stripe-hosted invoice URL + payment method update flow for any subject right request.
- **§42 CFR Part 2 (SUD confidentiality)** — irrelevant to M35 because M35 holds no SUD information. Listed here as a negative driver: M35 never holds any clinical category subject to 42 CFR Part 2.
- **HIPAA §164.514 (de-identification)** — the HMAC pseudonym discipline (D6) is conceptually aligned with §164.514(b)(1) "expert determination" de-identification, but M35 does not formally invoke §164.514 because M35 holds no PHI in the first place. The pseudonym is defense-in-depth.

The competitive driver is straightforward: hospice EHR competitors (Axxess, MatrixCare, WellSky, Homecare Homebase) bill agencies via a mix of legacy ACH and manual invoicing with periodic spreadsheet reconciliation. A modern self-serve Stripe-backed subscription experience (live invoice download, self-update payment method, transparent usage metering with real-time overage warnings) is a B2B SaaS table-stake that none of the legacy hospice ERH vendors have. The architecture's Phase 2 timing means M35 lands when WardenX has the second tenant and onward — exactly when the differentiator matters.

### 1.4 Competitive Context

Hospice EHR pricing is, today, opaque. Agencies negotiate annual contracts with legacy vendors; per-seat pricing is often padded with "implementation fees" and "platform fees" that hide the real cost. The WardenX commercial promise is: **published plan tiers, transparent meters, real-time usage visibility, self-serve plan change, no annual lock-in (monthly billing default with optional annual prepay discount).** M35 is the technical substrate that makes that promise operable. The hybrid per-seat + per-patient-month model (D1) is calibrated against the dominant cost driver in a hospice's WardenX usage: a small agency (10 active patients, 5 users) pays the Starter tier price; a mid-sized agency (75 active patients, 25 users) sits in Professional with predictable per-patient overage; a large agency or chain (250+ patients, 50+ users) sits in Enterprise with negotiated overages. The Stripe Tax surface means WardenX automatically charges the right state sales tax without WardenX building a tax engine.

The strategic value of M35 landing in Phase 2 (rather than Phase 1) is that Engrace's first nine months of operation are billing-free, which lets the M35 implementation be informed by real Engrace usage data. The plan tiers' included quantities are calibrated from Engrace's Phase-1 metering (which runs internally via the `usage_event` ingest pipeline turned on in Phase 1 with the Stripe-posting half turned off). At Phase 2 start, the plan tiers are tuned to Engrace's actual workload, not to a speculative pre-launch model.

-----

## 2. Domain Model

### 2.1 Entity-Relationship Diagram

```
                          Organization (M2, FK in)
                                │
                                │ 1:1
                                ▼
                        ┌───────────────┐
                        │  subscription │◄────── plan (platform-shared)
                        └───────┬───────┘            │
                                │ 1:N               │ 1:N
                ┌───────────────┼───────────────┐   │
                ▼               ▼               ▼   ▼
       ┌────────────┐  ┌───────────────┐   ┌─────────────┐
       │   invoice  │  │ dunning_state │   │ plan_meter  │
       └─────┬──────┘  └───────────────┘   └─────────────┘
             │ 1:N
             ▼
       ┌────────────┐                       ┌──────────────────────┐
       │invoice_line│◄──────────────────────│ usage_period_aggregate│
       └────────────┘                       └──────────┬───────────┘
                                                       │ 1:N
                                                       ▼
                                              ┌────────────────┐
                                              │   usage_event  │
                                              │ (partitioned)  │
                                              └────────────────┘
                                                       ▲
                              ┌────────────────────────┼────────────────────┐
                              │                        │                    │
                ┌─────────────────────────┐  ┌─────────────────────┐  ┌──────────────┐
                │ patient_active_period   │  │ user_active_period  │  │ (m28/m29/m32 │
                │ (pseudonymized)         │  │ (pseudonymized)     │  │  ingest)     │
                └─────────────────────────┘  └─────────────────────┘  └──────────────┘
                            ▲                          ▲
                            │ outbox subscription      │
                            │                          │
                       m5.patient.*               m2.session.created

       Organization (M2)
            │
            │ 1:1
            ▼
       ┌───────────────┐
       │ payment_method│ (Stripe-mirrored, metadata only)
       └───────────────┘

       Subscription
            │
            │ 1:N (append-only)
            ▼
       ┌───────────────────────────┐
       │ subscription_state_history│
       └───────────────────────────┘

       Invoice
            │
            │ 1:N
            ▼
       ┌─────────────┐
       │   refund    │ (4-stage workflow)
       └─────────────┘

       Organization
            │
            │ 1:N
            ▼
       ┌────────────────────────┐    promo_code (platform-shared)
       │ promo_code_application │◄──┐
       └────────────────────────┘   │
                                    │
                       Stripe pulls from this row to apply discount

       (platform-only)
       ┌──────────────────────────────┐
       │ revenue_recognition_snapshot │  ← monthly MRR/ARR aggregate
       └──────────────────────────────┘

       (platform-only)
       ┌─────────────────────────┐
       │ stripe_webhook_event    │  ← dedup + envelope-encrypted payload
       └─────────────────────────┘

       (platform-only)
       ┌─────────────────────────┐
       │ stripe_api_call_audit   │  ← outbound API call ledger
       └─────────────────────────┘
```

**Cardinality notes:**

- **One subscription per Organization, strictly enforced.** `subscription.organization_id` is `UNIQUE`. An Organization that re-subscribes after cancellation creates a new `subscription` row (the old one stays `canceled`); enforced via a partial unique index on `(organization_id) WHERE status NOT IN ('canceled', 'paused')`.
- **One default payment method per Organization.** `payment_method.is_default = true` is enforced unique per `organization_id` via a partial unique index.
- **`usage_event` is append-only and partitioned by month** (`recorded_at`). Old partitions are archived after 24 months but never UPDATEd or DELETEd in operational storage.
- **`usage_period_aggregate` is one row per `(subscription_id, event_type, period_start, period_end)`** — strict uniqueness enforced.
- **`subscription_state_history` is append-only.** Every state transition produces a row; the M4 audit trigger denies UPDATE/DELETE on this table.
- **`patient_active_period` and `user_active_period` are HMAC-pseudonym tables.** They never reference raw `patient_id` or `membership_id`; the keyspace is `(organization_id, patient_pseudonym, period_year_month)` and `(organization_id, membership_pseudonym, period_year_month)`. The HMAC key holder is M35-private (D6).

### 2.2 Per-Entity Lifecycle

**Plan.** A plan is created by `platform_admin` via the `/v1/admin/plans` route. It is `inactive` (draft) until the operator promotes it to `active`. An active plan may be `deprecated` (no new subscriptions on it; existing subscriptions grandfathered) but never deleted. The plan row mirrors a Stripe `product` + `price` pair (`stripe_product_id`, `stripe_price_id`). Plan changes that affect Stripe metadata (price, currency, meter mappings) are written to Stripe via the outbox-only path (D3) — never directly. A plan's meters are defined in `plan_meter`; each meter row mirrors a Stripe `meter` resource (`stripe_meter_id`). The plan catalog is platform-shared (D11) — all tenants see the same active plans.

**Subscription.** A subscription is created when an Organization first acquires a paid plan, via the `/v1/subscription` POST route. Initial state is `trialing` if the plan has a `trial_period_days` configured (D12), otherwise `active`. The state machine (per D7) advances through `trialing → active → past_due → at_risk → suspended → canceled` with the optional `paused` lateral state. Every state transition is written to `subscription_state_history`. The Stripe-side subscription is created in the same outbox-driven flow; if Stripe creation fails, the WardenX subscription remains in `pending` (a transient sub-state not in `status` — recorded in a temp pre-row that is converted to a real `subscription` only upon successful Stripe creation).

**Invoice.** Invoices are created *by Stripe* at the end of each billing period (or upon plan change for proration, or upon a one-time charge). The Stripe `m35.invoice.created` webhook triggers M35 to write a mirror row in `invoice` with `status='draft'` until Stripe transitions it to `open`. Subsequent webhooks (`invoice.finalized`, `m35.invoice.paid`, `m35.invoice.payment_failed`, `m35.invoice.voided`, `invoice.marked_uncollectible`) update the mirror. Invoices are never created directly by M35; the `/v1/invoices` POST route does not exist for tenants. Internal one-time charges (refund offsets, manual line items) go through `/v1/admin/invoices/charge` which calls Stripe's invoice items API.

**Invoice line.** Created in the same webhook flow as `invoice`. One `invoice_line` row per Stripe invoice line item, keyed on `stripe_line_id`. Line kinds: `subscription` (the base plan price), `metered` (usage-based overages, linked to a `plan_meter`), `one_time` (manual line items), `tax` (Stripe Tax computed), `discount` (promo or credit), `credit` (account credit application).

**Payment method.** Created via the Stripe Setup Intent flow on the frontend. Stripe Elements tokenizes the card; the frontend calls `/v1/payment_methods/attach` with the resulting payment method id; M35 calls Stripe to attach it to the Customer (via the outbox-only dispatcher), and Stripe returns the metadata (brand, last4, exp). On `payment_method.attached` webhook, M35 writes the row. A payment method is `deactivated` (soft-deleted) when removed; never hard-deleted, because invoice refunds may still reference it.

**Usage event.** Append-only. Ingested via the `UsageMeteringIngest` published seam (§4.3). Idempotency on `(organization_id, source_module, source_event_id)` — a re-delivered event from M28 or M32 is a no-op. Partitioned by month (`recorded_at`).

**Usage period aggregate.** Computed by the `usage-aggregator` cron (§4.8). Runs hourly to roll `usage_event` rows into per-period aggregate counts. At Stripe billing period close, the aggregate is posted to Stripe via `usage_record` API by the `stripe-usage-posting` cron. Idempotent on `stripe_usage_record_id`.

**Patient active period / user active period.** Append-only. Constructed by outbox subscribers (§4.5) consuming `m5.patient.*` and `m2.session.created` events. The HMAC pseudonym is computed at ingest time inside the M35 boundary; the raw id never lands in an M35 table. The `was_active` field is computed as: a patient is "active" in a billing period if they had `status='active'` for any day in the period; a user is "active" if they had at least one M2 session in the period.

**Subscription state history.** Append-only. Every state transition produces a row with `from_status`, `to_status`, `transitioned_at`, `actor_membership_id` (NULL for system transitions), `reason_code`, and `stripe_event_id` if the transition was triggered by a Stripe webhook.

**Stripe webhook event.** Append-only ingest log. Every inbound Stripe webhook produces a row, even if dedup-rejected (the dedup-reject still records `received_at` + the rejection note for forensics). Payload is envelope-encrypted (D15). Processing happens asynchronously from the route; the route returns `200 OK` after signature verification and dedup-write, regardless of processing outcome (Stripe's webhook delivery requires fast `200 OK` per Stripe TOS).

**Stripe API call audit.** Append-only ledger of every outbound API call to Stripe. The `stripe_idempotency_key` is unique. The request and response envelopes are stored with sensitive fields redacted (the `redactor` is in `packages/subscription-billing/src/stripe/redactor.ts` and is unit-tested against the Stripe API schema).

**Dunning state.** Append-only state machine ledger. Each dunning stage transition produces a row. The `current` stage is the row with the most recent `entered_at` and `exited_at IS NULL`. A subscription that recovers from `past_due` (e.g. card updated, invoice paid) gets an `exited_at` + `exit_reason='resolved'` row and a new `none` row.

**Revenue recognition snapshot.** Computed monthly. Append-only. Each row is the canonical MRR/ARR figure for that month-end.

**Promo code.** Created in Stripe by `platform_admin` via the admin console (`/v1/admin/promos`). M35 mirrors the Stripe coupon + promotion code into `promo_code`. Applied to a subscription via `/v1/admin/subscriptions/:id/apply_promo`. The application is recorded in `promo_code_application` with the M4 audit linkage.

**Refund.** Four-stage lifecycle per D16: `requested → approved → executed → success | failed | denied`. Initiated by `billing_admin`; approved by `platform_admin` (with audit-event step-up auth per M2 SESSION_POLICY billing-credential-admin profile); executed by the outbox dispatcher; success/fail recorded on the row.

### 2.3 Validation Rules (Domain-Level, Not the Wire-Shape Schemas)

- **One subscription per Organization at a time.** Partial unique index `subscription_org_active_uq ON subscription (organization_id) WHERE status NOT IN ('canceled', 'paused')`.
- **A subscription's `plan_id` must reference an `active` or `deprecated` plan.** Grandfathering allows existing subscriptions on a deprecated plan; new subscriptions must use `active`.
- **A subscription cannot transition from `canceled` back to any active state.** Enforced via the XState transition map (D7). A "reactivation" creates a new subscription row.
- **`invoice.total_cents = invoice.subtotal_cents + invoice.tax_cents`** — CHECK constraint.
- **`SUM(invoice_line.total_cents WHERE kind != 'tax') = invoice.subtotal_cents`** and **`SUM(invoice_line.total_cents WHERE kind = 'tax') = invoice.tax_cents`** — enforced via the reconciler (cannot be a CHECK constraint because lines are inserted across multiple webhook events; the reconciler asserts equality on `invoice.status = 'open'` transition and emits an alert on mismatch).
- **`payment_method.is_default = true`** is unique per `organization_id` (partial unique index).
- **`usage_event.quantity > 0`** — CHECK constraint. Negative usage is recorded as a separate `kind='reversal'` event with positive quantity (reversal logic is at aggregation, not ingest).
- **`patient_active_period.patient_pseudonym` is exactly 32 hex chars** (HMAC-SHA256 output, hex-encoded) — CHECK constraint. The raw `patient_id` cannot accidentally land here because UUIDs are 36 chars with dashes and the CHECK regex `^[a-f0-9]{32}$` excludes them.
- **`refund.amount_cents <= invoice.amount_paid_cents`** — partial check (full check is in application code that joins; CHECK constraint asserts `refund.amount_cents > 0`).
- **`dunning_state.dunning_stage` advances monotonically within a single subscription's active dunning sequence** — enforced by the `dunning-engine` cron's transition rules; CHECK constraint on the enum ordering.

### 2.4 Side Effects

| Action | Outbox / Audit / Alert / Cron |
|---|---|
| `subscription` insert | `m35.subscription.created` outbox + M4 audit + alert to `org_admin` ("Welcome to WardenX, your trial begins now") |
| `subscription.status` transition to `active` from `trialing` | `m35.subscription.activated` outbox + M4 audit + alert to `org_admin` ("Your trial converted") |
| `subscription.status` transition to `past_due` | `m35.subscription.status_changed` outbox + M4 audit + `dunning-engine` enqueue + alert to `org_admin` + `billing_admin` ("Payment failed; please update method") |
| `subscription.status` transition to `suspended` | `m35.subscription.status_changed` + `m35.tenant.billing_blocked` outbox + M4 audit + alert to `org_admin` + `compliance_officer` (critical) |
| `subscription.status` transition to `canceled` | `m35.subscription.canceled` outbox + M4 audit + alert to `org_admin` |
| `subscription.plan_id` change | `m35.subscription.plan_changed` outbox + M4 audit + alert to `org_admin` (with old → new diff) |
| `invoice` insert (Stripe webhook) | `m35.invoice.created` outbox + alert to `billing_admin` (link to Stripe-hosted URL) |
| `invoice.status` → `paid` | `m35.invoice.paid` outbox + alert to `billing_admin` (silent if auto-paid; explicit if manual) |
| `invoice.status` → `void` | `m35.invoice.voided` outbox + M4 audit + alert to `billing_admin` |
| `invoice.payment_failed` webhook | `m35.invoice.payment_failed` outbox + `dunning-engine` advancement + alert to `org_admin` + `billing_admin` (critical) |
| `payment_method` insert | `m35.payment_method.added` outbox + M4 audit |
| `payment_method.is_default` change | `m35.payment_method.added` outbox (variant) + M4 audit |
| `payment_method.expires_at` within 30/14/7/1 days (cron) | `m35.payment_method.expiring_soon` outbox + alert to `billing_admin` |
| `payment_method` removal | `m35.payment_method.removed` outbox + M4 audit |
| `usage_event` insert | (no outbox; high-volume; aggregator picks up via cron) |
| `usage_period_aggregate` insert / total update | `m35.usage.period_closed` outbox (on close, not on every aggregate update) |
| `usage_period_aggregate` total crosses 80% of included quantity | `m35.usage.overage_threshold_warning` outbox + alert to `billing_admin` (warn) |
| `usage_period_aggregate` total crosses 100% of included quantity | `m35.usage.overage_threshold_breached` outbox + alert to `billing_admin` (info — overage is expected behavior, just informative) |
| `refund` requested | `m35.refund.requested` outbox + M4 audit + alert to `platform_admin` (for approval) |
| `refund` approved | `m35.refund.approved` outbox + M4 audit + step-up token verification |
| `refund` executed | `m35.refund.executed` outbox + M4 audit + alert to `billing_admin` |
| `refund` failed at Stripe | `m35.refund.failed` outbox + M4 audit + alert to `platform_admin` + `billing_admin` (critical) |
| `promo_code_application` insert | `m35.promo.applied` outbox + M4 audit |
| `stripe_webhook_event` insert | `m35.stripe.webhook_received` outbox (internal; drives the handler workers) |
| `stripe_api_call_audit` failure (non-2xx) | `m35.stripe.api_call_failed` outbox + alert (escalates to `platform_admin` on the 3rd consecutive failure for the same operation) |
| `revenue_recognition_snapshot` insert (monthly cron) | `m35.revenue.monthly_snapshot_computed` outbox (platform-wide) |
| Inbound `m2.organization.suspended` | `subscription` → `paused` + Stripe API call to pause subscription |
| Inbound `m2.organization.closed` | `subscription` → `canceled` (cancel at period end) + Stripe API call |
| Inbound `m5.patient.status_changed` | `patient_active_period` aggregator advancement |
| Inbound `m2.session.created` | `user_active_period` aggregator advancement |

### 2.5 Concurrency

Subscription state mutation is concurrency-controlled via **`SELECT ... FOR UPDATE`** on `subscription` rows. Two concurrent operations (e.g. tenant clicks "Cancel" at the same moment as the cron advances dunning) serialize at the row lock; the second waits for the first to commit and then re-evaluates its preconditions (the XState transition guard re-checks the current state before applying). Stripe webhook processing acquires the same row lock so a webhook arriving mid-mutation does not produce inconsistent state.

`usage_event` is high-volume insert-only; no row locking is required. The `usage-aggregator` cron uses `SELECT ... FOR UPDATE SKIP LOCKED` on `usage_period_aggregate` rows to handle concurrent aggregator runs (one tenant's aggregator should never block another's).

The dunning engine cron uses `SELECT ... FOR UPDATE SKIP LOCKED` on `subscription` rows in `past_due` / `at_risk` states, so one slow tenant cannot block the others' dunning advancement.

### 2.6 Idempotency

| Operation | Idempotency mechanism |
|---|---|
| Inbound Stripe webhook | `stripe_webhook_event.id` (PK = Stripe event id); duplicate POST returns 200 with no side effects |
| Outbound Stripe API call | Stripe-native idempotency key: `stripe-idem-{operation}-{businessKey}-{attempt}`; deterministic; Stripe returns the cached response for a repeated key |
| `usage_event` ingest via seam | `(organization_id, source_module, source_event_id)` unique index; re-delivered event is a no-op |
| `usage_period_aggregate` recomputation | `(subscription_id, event_type, period_start, period_end)` unique index; recompute on existing row UPDATEs the total atomically |
| Stripe `usage_record` posting | `usage_period_aggregate.stripe_usage_record_id` records the response on first success; subsequent attempts short-circuit |
| Outbox event publication | M1 outbox dedup on `(module, aggregate_id, event_type, version)` |
| Dunning stage transition | `dunning_state.dunning_stage` + `entered_at` uniqueness within a subscription's open dunning sequence |
| Patient/user active-period ingest | `(organization_id, pseudonym, period_year_month)` unique index; idempotent re-ingest produces no duplicates |
| Refund execution | `refund.stripe_refund_id` unique; the dispatcher checks this before calling Stripe |
| Plan creation/update | The Stripe `product` and `price` ids are created on first plan creation and cached; updates are routed via `stripe_product_id` lookup |

-----

## 3. Drizzle Schema

### 3.1 Package Layout

```
packages/subscription-billing/
├── package.json
├── tsconfig.json
├── drizzle.config.ts
└── src/
    ├── index.ts                          # re-exports the public surface
    ├── schema/
    │   ├── enums.ts                      # plan_tier, billing_cadence, subscription_status, dunning_stage, ...
    │   ├── plan.ts
    │   ├── plan-meter.ts
    │   ├── subscription.ts
    │   ├── subscription-state-history.ts
    │   ├── payment-method.ts
    │   ├── invoice.ts
    │   ├── invoice-line.ts
    │   ├── usage-event.ts                # partitioned-by-month parent
    │   ├── usage-period-aggregate.ts
    │   ├── patient-active-period.ts
    │   ├── user-active-period.ts
    │   ├── stripe-webhook-event.ts
    │   ├── stripe-api-call-audit.ts
    │   ├── dunning-state.ts
    │   ├── revenue-recognition-snapshot.ts
    │   ├── promo-code.ts
    │   ├── promo-code-application.ts
    │   ├── refund.ts
    │   └── patient-pseudonym-key.ts      # M35-private HMAC key catalog
    ├── seams/
    │   ├── published/
    │   │   ├── subscription-state-provider.ts
    │   │   ├── billing-status-provider.ts
    │   │   ├── usage-metering-ingest.ts
    │   │   ├── patient-counter-provider.ts
    │   │   ├── revenue-metrics-provider.ts
    │   │   └── plan-catalog-reader.ts
    │   └── consumed/
    │       ├── organization-reader.ts             # from M2
    │       ├── membership-reader.ts               # from M2
    │       ├── alert-emitter.ts                   # from M36
    │       ├── terminology-provider.ts            # from M38
    │       ├── fhir-gateway-metrics.ts            # from M28 (forward-seam deny-stub)
    │       ├── external-interface-metrics.ts      # from M29 (forward-seam deny-stub)
    │       ├── ai-token-meter.ts                  # from M32 (forward-seam deny-stub)
    │       └── onboarding-status.ts               # from M34 (forward-seam deny-stub)
    ├── stripe/
    │   ├── client.ts                     # the Stripe SDK wrapper
    │   ├── redactor.ts                   # PHI-pseudonym + sensitive-field redactor
    │   ├── idempotency.ts                # idempotency-key derivation
    │   ├── webhook-verifier.ts           # HMAC signature verification
    │   ├── product-sync.ts               # plan ↔ Stripe product/price sync
    │   ├── customer-sync.ts              # Organization ↔ Stripe Customer sync
    │   ├── subscription-sync.ts          # WardenX ↔ Stripe subscription sync
    │   └── usage-record-poster.ts        # usage_period_aggregate → Stripe usage_record
    ├── pseudonym/
    │   ├── hasher.ts                     # HMAC-SHA256 with key rotation
    │   ├── key-rotator.ts                # platform-key rotation manager
    │   └── reverse-map.ts                # WardenX-private (operator-only) reverse lookup if needed for forensics
    ├── state-machine/
    │   ├── subscription.ts               # XState v5 machine
    │   └── dunning.ts                    # XState v5 machine
    ├── reconciler/
    │   ├── subscription-reconciler.ts
    │   ├── invoice-reconciler.ts
    │   └── payment-method-reconciler.ts
    ├── usage/
    │   ├── ingest.ts                     # UsageMeteringIngest seam impl
    │   ├── aggregator.ts                 # usage-aggregator cron
    │   └── poster.ts                     # stripe-usage-posting cron
    ├── dunning/
    │   └── engine.ts                     # dunning-engine cron
    ├── revenue/
    │   └── snapshot.ts                   # revenue-snapshot cron
    ├── ingestors/
    │   ├── patient-active-period.ts      # m5.patient.* outbox subscriber
    │   └── user-active-period.ts         # m2.session.created outbox subscriber
    └── outbox.ts                         # M1 outbox helpers for emitting m35.* events

apps/backend/src/modules/35-subscription-billing/
├── routes/
│   ├── subscription.ts
│   ├── payment-methods.ts
│   ├── invoices.ts
│   ├── plans.public.ts                   # unauthenticated plan catalog
│   ├── webhooks.stripe.ts                # POST /v1/webhooks/stripe
│   └── admin/
│       ├── plans.ts
│       ├── subscriptions.ts
│       ├── refunds.ts
│       ├── dunning.ts
│       ├── promos.ts
│       └── revenue.ts
├── workers/
│   ├── stripe-dispatcher.ts              # drains m35.stripe.* outbox events
│   ├── stripe-webhook-handler.ts         # drains m35.stripe.webhook_received
│   ├── payment-method-expiry-watch.ts
│   └── billing-status-broadcaster.ts     # propagates billing status to M34
├── crons/
│   ├── usage-aggregator.cron.ts
│   ├── stripe-usage-posting.cron.ts
│   ├── subscription-reconciler.cron.ts
│   ├── dunning-engine.cron.ts
│   └── revenue-snapshot.cron.ts
└── boot/
    ├── register-seams.ts
    ├── register-permissions.ts
    ├── register-predicates.ts
    ├── register-ai-block.ts              # validateM35AIBlock()
    └── register-eraser.ts                # M4 destruction workflow registration
```

### 3.2 Migration Script Phases (`0035_subscription_billing.sql`)

The migration runs as a single transaction in five ordered phases:

1. **ENUM types** (`plan_tier`, `billing_cadence`, `subscription_status`, `dunning_stage`, `invoice_status`, `invoice_line_kind`, `refund_status`, `refund_kind`, `promo_kind`, `promo_duration`, `payment_method_kind`, `usage_event_type`, `usage_event_source_module`, `inactivity_reason`).
2. **Platform-shared tables** (`plan`, `plan_meter`, `promo_code`, `revenue_recognition_snapshot`, `patient_pseudonym_key`). These are created without RLS — they are platform-wide.
3. **Tenant-scoped tables** (`subscription`, `subscription_state_history`, `payment_method`, `invoice`, `invoice_line`, `usage_event` parent + first six monthly partitions, `usage_period_aggregate`, `patient_active_period`, `user_active_period`, `dunning_state`, `promo_code_application`, `refund`). All have RLS enabled.
4. **Platform-only audit tables** (`stripe_webhook_event`, `stripe_api_call_audit`). Not tenant-scoped (Stripe webhooks may carry data spanning multiple tenants in one webhook event).
5. **Indexes, partial-unique indexes, CHECK constraints, foreign keys, RLS policies, and audit denylist registrations** applied last so the table-creation pass is fast.

The reverse migration drops in reverse order; foreign keys cascade-delete on the eraser path but reject on the normal drop path.

### 3.3 Schema Files (Drizzle)

```typescript
// packages/subscription-billing/src/schema/enums.ts
import { pgEnum } from 'drizzle-orm/pg-core'

export const planTier = pgEnum('plan_tier', ['starter', 'professional', 'enterprise'])
export const billingCadence = pgEnum('billing_cadence', ['monthly', 'annual'])
export const subscriptionStatus = pgEnum('subscription_status', [
  'trialing', 'active', 'past_due', 'at_risk', 'suspended', 'canceled', 'paused',
])
export const dunningStage = pgEnum('dunning_stage', [
  'none', 'day_1', 'day_7', 'day_14', 'day_21', 'day_28_suspend', 'day_60_cancel', 'resolved',
])
export const invoiceStatus = pgEnum('invoice_status', [
  'draft', 'open', 'paid', 'void', 'uncollectible',
])
export const invoiceLineKind = pgEnum('invoice_line_kind', [
  'subscription', 'metered', 'one_time', 'tax', 'discount', 'credit', 'proration',
])
export const refundStatus = pgEnum('refund_status', [
  'requested', 'approved', 'denied', 'executed_success', 'executed_failed',
])
export const refundKind = pgEnum('refund_kind', ['full', 'partial', 'credit_only'])
export const promoKind = pgEnum('promo_kind', ['percent_off', 'amount_off'])
export const promoDuration = pgEnum('promo_duration', ['once', 'repeating', 'forever'])
export const paymentMethodKind = pgEnum('payment_method_kind', ['card', 'us_bank_account', 'sepa_debit', 'other'])
export const usageEventType = pgEnum('usage_event_type', [
  'active_patient', 'active_user', 'claim_submitted_medicare', 'claim_submitted_medicaid',
  'ai_tokens_consumed', 'fhir_egress_request', 'hl7_message_inbound', 'hl7_message_outbound',
])
export const usageEventSourceModule = pgEnum('usage_event_source_module', [
  'm1', 'm2', 'm5', 'm23', 'm24', 'm28', 'm29', 'm32',
])
export const inactivityReason = pgEnum('inactivity_reason', ['discharged', 'died', 'revoked', 'transferred'])
```

```typescript
// packages/subscription-billing/src/schema/plan.ts
// Platform-shared (no RLS). Plan catalog is platform-owned per D11.
import { pgTable, uuid, text, integer, bigint, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { planTier, billingCadence } from './enums'

export const plan = pgTable('plan', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),                                                       // 'starter-monthly', 'professional-annual', etc.
  name: text('name').notNull(),                                                       // human-readable display name
  description: text('description'),
  tier: planTier('tier').notNull(),
  cadence: billingCadence('cadence').notNull(),
  basePriceCents: bigint('base_price_cents', { mode: 'number' }).notNull(),
  currencyCode: text('currency_code').notNull().default('USD'),                       // ISO 4217; M38-validated
  trialPeriodDays: integer('trial_period_days').notNull().default(14),                // D12 platform floor
  isActive: boolean('is_active').notNull().default(false),                            // draft until promoted
  deprecatedAt: timestamp('deprecated_at', { withTimezone: true }),                   // grandfathered after this
  stripeProductId: text('stripe_product_id'),                                         // set on first Stripe sync
  stripePriceId: text('stripe_price_id'),                                             // set on first Stripe sync
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
  validTo: timestamp('valid_to', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugUq: uniqueIndex('plan_slug_uq').on(t.slug),
  tierCadenceIx: index('plan_tier_cadence_ix').on(t.tier, t.cadence),
  activeIx: index('plan_active_ix').on(t.isActive).where(sql`is_active = true`),
}))
```

```typescript
// packages/subscription-billing/src/schema/plan-meter.ts
// Platform-shared. One row per (plan_id, event_type).
import { pgTable, uuid, text, integer, bigint, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { plan } from './plan'
import { usageEventType } from './enums'

export const planMeter = pgTable('plan_meter', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => plan.id, { onDelete: 'restrict' }),
  eventType: usageEventType('event_type').notNull(),
  inclusiveQuantity: bigint('inclusive_quantity', { mode: 'number' }).notNull().default(0),  // included in base price
  overageUnitPriceCents: bigint('overage_unit_price_cents', { mode: 'number' }).notNull(),
  billingAggregation: text('billing_aggregation').notNull(),                                  // 'sum' | 'last' | 'count'
  stripeMeterId: text('stripe_meter_id'),                                                      // set on first Stripe sync
  warningThresholdPercent: integer('warning_threshold_percent').notNull().default(80),         // alert at 80% of inclusive
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  planEventUq: uniqueIndex('plan_meter_plan_event_uq').on(t.planId, t.eventType),
}))
```

```typescript
// packages/subscription-billing/src/schema/patient-pseudonym-key.ts
// Platform-shared (no RLS). M35-private. Stores the active and historic HMAC keys for pseudonym computation.
// The key bytes are envelope-encrypted at the application layer (KMS-wrapped).
import { pgTable, uuid, text, timestamp, boolean, uniqueIndex } from 'drizzle-orm/pg-core'

export const patientPseudonymKey = pgTable('patient_pseudonym_key', {
  id: uuid('id').primaryKey().defaultRandom(),
  keyEpoch: text('key_epoch').notNull(),                                              // 'epoch-2026-01', 'epoch-2026-07', ...
  keyMaterialCiphertext: text('key_material_ciphertext').notNull(),                    // KMS-wrapped HMAC secret
  keyKmsRef: text('key_kms_ref').notNull(),                                            // KMS key identifier used to wrap
  isActive: boolean('is_active').notNull().default(false),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  epochUq: uniqueIndex('patient_pseudonym_key_epoch_uq').on(t.keyEpoch),
  oneActiveUq: uniqueIndex('patient_pseudonym_key_one_active_uq').on(t.isActive).where(sql`is_active = true`),
}))
```

```typescript
// packages/subscription-billing/src/schema/subscription.ts
// Tenant-scoped. RLS enabled. One per Organization.
// M35-F04 (ADR-0011 / ARCH-147): organization_id is a plain uuid column (logical FK, RLS-governed).
// M35 must NOT import the M1/M2 `organizations` Drizzle schema. Cross-module org/membership
// identity is resolved via OrganizationReader / MembershipReader seams and request context;
// the database FK constraint is enforced by the M1 RLS/tenancy helper, not by a Drizzle
// .references() call into packages/db/src/schema/organizations.
import { pgTable, uuid, integer, boolean, timestamp, text, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { plan } from './plan'
import { subscriptionStatus } from './enums'

export const subscription = pgTable('subscription', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(), // logical FK to M2 organizations; RLS-governed — no cross-module .references()
  planId: uuid('plan_id').notNull().references(() => plan.id, { onDelete: 'restrict' }),

  // Stripe linkage:
  stripeCustomerId: text('stripe_customer_id'),                                       // set on first Stripe sync
  stripeSubscriptionId: text('stripe_subscription_id'),                               // set on first Stripe sync

  status: subscriptionStatus('status').notNull().default('trialing'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  billingAnchorDay: integer('billing_anchor_day'),                                    // day-of-month
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  canceledAt: timestamp('canceled_at', { withTimezone: true }),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  pausedUntil: timestamp('paused_until', { withTimezone: true }),
  dunningStartedAt: timestamp('dunning_started_at', { withTimezone: true }),

  defaultPaymentMethodId: uuid('default_payment_method_id'),                          // FK enforced in payment_method

  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgActiveUq: uniqueIndex('subscription_org_active_uq').on(t.organizationId)
    .where(sql`status NOT IN ('canceled', 'paused')`),
  stripeCustomerUq: uniqueIndex('subscription_stripe_customer_uq').on(t.stripeCustomerId),
  stripeSubscriptionUq: uniqueIndex('subscription_stripe_subscription_uq').on(t.stripeSubscriptionId),
  statusIx: index('subscription_status_ix').on(t.status),
  periodEndIx: index('subscription_period_end_ix').on(t.currentPeriodEnd),
}))
```

```typescript
// packages/subscription-billing/src/schema/subscription-state-history.ts
// Tenant-scoped. RLS enabled. Append-only (M4 audit trigger denies UPDATE/DELETE).
// M35-F04 (ADR-0011 / ARCH-147): organization_id is a plain uuid column — no cross-module .references().
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core'
import { subscription } from './subscription'
import { subscriptionStatus } from './enums'

export const subscriptionStateHistory = pgTable('subscription_state_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(), // logical FK to M2 organizations; RLS-governed
  subscriptionId: uuid('subscription_id').notNull().references(() => subscription.id, { onDelete: 'restrict' }),
  fromStatus: subscriptionStatus('from_status'),
  toStatus: subscriptionStatus('to_status').notNull(),
  transitionedAt: timestamp('transitioned_at', { withTimezone: true }).notNull().defaultNow(),
  actorMembershipId: uuid('actor_membership_id'),                                     // NULL for system transitions
  reasonCode: text('reason_code').notNull(),
  reasonDetail: text('reason_detail'),
  stripeEventId: text('stripe_event_id'),                                             // if transition was triggered by Stripe webhook
  m4AuditEventId: uuid('m4_audit_event_id'),
}, (t) => ({
  subIx: index('subscription_state_history_sub_ix').on(t.subscriptionId, t.transitionedAt),
}))
```

```typescript
// packages/subscription-billing/src/schema/payment-method.ts
// Tenant-scoped. RLS enabled. Stripe-mirrored metadata only — no PAN, no CVV.
// M35-F04 (ADR-0011 / ARCH-147): organization_id is a plain uuid column — no cross-module .references().
import { pgTable, uuid, text, boolean, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { paymentMethodKind } from './enums'

export const paymentMethod = pgTable('payment_method', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(), // logical FK to M2 organizations; RLS-governed
  stripePaymentMethodId: text('stripe_payment_method_id').notNull(),
  kind: paymentMethodKind('kind').notNull(),

  // Card metadata (only filled when kind='card'):
  cardBrand: text('card_brand'),                                                      // 'visa', 'mastercard', ...
  cardLast4: text('card_last4'),                                                      // 4-digit
  cardExpMonth: integer('card_exp_month'),
  cardExpYear: integer('card_exp_year'),
  cardWalletKind: text('card_wallet_kind'),                                           // 'apple_pay', 'google_pay', null

  // ACH metadata (only filled when kind='us_bank_account'):
  achBankName: text('ach_bank_name'),
  achAccountLast4: text('ach_account_last4'),
  achAccountType: text('ach_account_type'),                                           // 'checking', 'savings'

  // SEPA metadata (only filled when kind='sepa_debit'):
  sepaCountry: text('sepa_country'),
  sepaLast4: text('sepa_last4'),

  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  expiresAt: timestamp('expires_at', { withTimezone: true }),                          // computed for cards
  attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  stripePmUq: uniqueIndex('payment_method_stripe_pm_uq').on(t.stripePaymentMethodId),
  orgDefaultUq: uniqueIndex('payment_method_org_default_uq').on(t.organizationId)
    .where(sql`is_default = true AND is_active = true`),
  orgActiveIx: index('payment_method_org_active_ix').on(t.organizationId, t.isActive),
}))
```

```typescript
// packages/subscription-billing/src/schema/invoice.ts
// Tenant-scoped. RLS enabled. Stripe-authoritative; this is a mirror.
// M35-F04 (ADR-0011 / ARCH-147): organization_id is a plain uuid column — no cross-module .references().
import { pgTable, uuid, text, bigint, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { subscription } from './subscription'
import { invoiceStatus } from './enums'

export const invoice = pgTable('invoice', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(), // logical FK to M2 organizations; RLS-governed
  subscriptionId: uuid('subscription_id').references(() => subscription.id, { onDelete: 'restrict' }),
  stripeInvoiceId: text('stripe_invoice_id').notNull(),
  invoiceNumber: text('invoice_number'),                                              // Stripe-assigned, e.g. 'WX-2026-0001'

  status: invoiceStatus('status').notNull().default('draft'),
  subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
  taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
  amountPaidCents: bigint('amount_paid_cents', { mode: 'number' }).notNull().default(0),
  amountDueCents: bigint('amount_due_cents', { mode: 'number' }).notNull().default(0),
  currencyCode: text('currency_code').notNull().default('USD'),

  periodStart: timestamp('period_start', { withTimezone: true }),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  voidedAt: timestamp('voided_at', { withTimezone: true }),

  hostedInvoiceUrl: text('hosted_invoice_url'),
  invoicePdfUrl: text('invoice_pdf_url'),

  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  stripeInvoiceUq: uniqueIndex('invoice_stripe_invoice_uq').on(t.stripeInvoiceId),
  orgStatusIx: index('invoice_org_status_ix').on(t.organizationId, t.status),
  invoiceNumberIx: index('invoice_number_ix').on(t.invoiceNumber),
}))
```

```typescript
// packages/subscription-billing/src/schema/invoice-line.ts
// M35-F04 (ADR-0011 / ARCH-147): organization_id is a plain uuid column — no cross-module .references().
import { pgTable, uuid, text, integer, bigint, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { invoice } from './invoice'
import { planMeter } from './plan-meter'
import { invoiceLineKind, usageEventType } from './enums'

export const invoiceLine = pgTable('invoice_line', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(), // logical FK to M2 organizations; RLS-governed
  invoiceId: uuid('invoice_id').notNull().references(() => invoice.id, { onDelete: 'restrict' }),
  stripeLineId: text('stripe_line_id').notNull(),
  kind: invoiceLineKind('kind').notNull(),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull().default(1),
  unitAmountCents: bigint('unit_amount_cents', { mode: 'number' }).notNull().default(0),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
  periodStart: timestamp('period_start', { withTimezone: true }),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  meterEventType: usageEventType('meter_event_type'),
  planMeterId: uuid('plan_meter_id').references(() => planMeter.id, { onDelete: 'set null' }),
}, (t) => ({
  stripeLineUq: uniqueIndex('invoice_line_stripe_line_uq').on(t.stripeLineId),
  invoiceIx: index('invoice_line_invoice_ix').on(t.invoiceId),
}))
```

```typescript
// packages/subscription-billing/src/schema/usage-event.ts
// Tenant-scoped, RLS enabled. Append-only. Partitioned by `recorded_at` (monthly).
// The partitioning is declared in the migration with `PARTITION BY RANGE (recorded_at)`.
// M35-F04 (ADR-0011 / ARCH-147): organization_id is a plain uuid column — no cross-module .references().
import { pgTable, uuid, text, bigint, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { usageEventType, usageEventSourceModule } from './enums'

export const usageEvent = pgTable('usage_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(), // logical FK to M2 organizations; RLS-governed
  subscriptionId: uuid('subscription_id'),                                            // nullable; might be unbilled
  eventType: usageEventType('event_type').notNull(),
  quantity: bigint('quantity', { mode: 'number' }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  sourceModule: usageEventSourceModule('source_module').notNull(),
  sourceEventId: text('source_event_id'),                                             // idempotency key from source
  metadataRedacted: jsonb('metadata_redacted').notNull().default({}),                  // PHI-free; redactor-checked
}, (t) => ({
  sourceDedupUq: uniqueIndex('usage_event_source_dedup_uq')
    .on(t.organizationId, t.sourceModule, t.sourceEventId)
    .where(sql`source_event_id IS NOT NULL`),
  orgRecordedIx: index('usage_event_org_recorded_ix').on(t.organizationId, t.recordedAt),
  eventTypeIx: index('usage_event_event_type_ix').on(t.eventType, t.recordedAt),
}))
```

```typescript
// packages/subscription-billing/src/schema/usage-period-aggregate.ts
// M35-F04 (ADR-0011 / ARCH-147): organization_id is a plain uuid column — no cross-module .references().
import { pgTable, uuid, text, bigint, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { subscription } from './subscription'
import { usageEventType } from './enums'

export const usagePeriodAggregate = pgTable('usage_period_aggregate', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(), // logical FK to M2 organizations; RLS-governed
  subscriptionId: uuid('subscription_id').notNull().references(() => subscription.id, { onDelete: 'restrict' }),
  eventType: usageEventType('event_type').notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  totalQuantity: bigint('total_quantity', { mode: 'number' }).notNull().default(0),
  inclusiveQuantity: bigint('inclusive_quantity', { mode: 'number' }).notNull().default(0),
  overageQuantity: bigint('overage_quantity', { mode: 'number' }).notNull().default(0),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  stripeUsageRecordId: text('stripe_usage_record_id'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  postAttemptCount: integer('post_attempt_count').notNull().default(0),
  warningEmittedAt: timestamp('warning_emitted_at', { withTimezone: true }),           // at 80% threshold
  breachEmittedAt: timestamp('breach_emitted_at', { withTimezone: true }),             // at 100% threshold
}, (t) => ({
  uniquePeriod: uniqueIndex('usage_period_aggregate_uq')
    .on(t.subscriptionId, t.eventType, t.periodStart, t.periodEnd),
  unpostedIx: index('usage_period_aggregate_unposted_ix')
    .on(t.computedAt).where(sql`stripe_usage_record_id IS NULL`),
}))
```

```typescript
// packages/subscription-billing/src/schema/patient-active-period.ts
// Tenant-scoped, RLS enabled. Pseudonymized — never holds raw patient_id.
// M35-F04 (ADR-0011 / ARCH-147): organization_id is a plain uuid column — no cross-module .references().
import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { inactivityReason } from './enums'

export const patientActivePeriod = pgTable('patient_active_period', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(), // logical FK to M2 organizations; RLS-governed
  patientPseudonym: text('patient_pseudonym').notNull(),                              // 32-hex HMAC-SHA256
  pseudonymKeyEpoch: text('pseudonym_key_epoch').notNull(),                            // FK in patient_pseudonym_key.key_epoch
  periodYearMonth: text('period_year_month').notNull(),                                // 'YYYY-MM'
  wasActive: boolean('was_active').notNull().default(false),
  becameActiveAt: timestamp('became_active_at', { withTimezone: true }),
  becameInactiveAt: timestamp('became_inactive_at', { withTimezone: true }),
  inactivityReason: inactivityReason('inactivity_reason'),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pseudoUq: uniqueIndex('patient_active_period_uq')
    .on(t.organizationId, t.patientPseudonym, t.periodYearMonth),
  orgPeriodIx: index('patient_active_period_org_period_ix').on(t.organizationId, t.periodYearMonth),
  pseudonymFormatCk: check('patient_active_period_pseudonym_format_ck',
    sql`patient_pseudonym ~ '^[a-f0-9]{32}$'`),
}))
```

```typescript
// packages/subscription-billing/src/schema/user-active-period.ts
// Tenant-scoped, RLS enabled. Pseudonymized — never holds raw membership_id.
// M35-F04 (ADR-0011 / ARCH-147): organization_id is a plain uuid column — no cross-module .references().
import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const userActivePeriod = pgTable('user_active_period', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(), // logical FK to M2 organizations; RLS-governed
  membershipPseudonym: text('membership_pseudonym').notNull(),                        // 32-hex HMAC-SHA256
  pseudonymKeyEpoch: text('pseudonym_key_epoch').notNull(),
  periodYearMonth: text('period_year_month').notNull(),
  wasActive: boolean('was_active').notNull().default(false),
  firstSessionAt: timestamp('first_session_at', { withTimezone: true }),
  lastSessionAt: timestamp('last_session_at', { withTimezone: true }),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pseudoUq: uniqueIndex('user_active_period_uq')
    .on(t.organizationId, t.membershipPseudonym, t.periodYearMonth),
  orgPeriodIx: index('user_active_period_org_period_ix').on(t.organizationId, t.periodYearMonth),
  pseudonymFormatCk: check('user_active_period_pseudonym_format_ck',
    sql`membership_pseudonym ~ '^[a-f0-9]{32}$'`),
}))
```

```typescript
// packages/subscription-billing/src/schema/stripe-webhook-event.ts
// Platform-only (not tenant-scoped). Envelope-encrypted payload (D15).
import { pgTable, text, timestamp, integer, uniqueIndex, index } from 'drizzle-orm/pg-core'

export const stripeWebhookEvent = pgTable('stripe_webhook_event', {
  id: text('id').primaryKey(),                                                          // Stripe event id (e.g. 'evt_...')
  eventType: text('event_type').notNull(),
  apiVersion: text('api_version'),
  payloadCiphertext: text('payload_ciphertext').notNull(),                              // envelope-encrypted
  payloadDekRef: text('payload_dek_ref').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  processingAttemptCount: integer('processing_attempt_count').notNull().default(0),
  signatureVerifiedAt: timestamp('signature_verified_at', { withTimezone: true }).notNull(),
  errorText: text('error_text'),
  derivedOrganizationId: text('derived_organization_id'),                               // null if not yet matched
}, (t) => ({
  eventTypeReceivedIx: index('stripe_webhook_event_type_received_ix').on(t.eventType, t.receivedAt),
  unprocessedIx: index('stripe_webhook_event_unprocessed_ix').on(t.receivedAt).where(sql`processed_at IS NULL`),
}))
```

```typescript
// packages/subscription-billing/src/schema/stripe-api-call-audit.ts
// Platform-only. Append-only ledger of every outbound Stripe API call.
import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core'

export const stripeApiCallAudit = pgTable('stripe_api_call_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  stripeIdempotencyKey: text('stripe_idempotency_key').notNull(),
  operation: text('operation').notNull(),                                              // 'customer.create', 'subscription.update', ...
  targetResourceId: text('target_resource_id'),                                        // Stripe id of the resource acted upon
  organizationId: uuid('organization_id'),                                             // nullable — some ops are platform-wide
  requestEnvelopeRedacted: jsonb('request_envelope_redacted').notNull(),
  responseStatusCode: integer('response_status_code'),
  responseEnvelopeRedacted: jsonb('response_envelope_redacted'),
  calledAt: timestamp('called_at', { withTimezone: true }).notNull().defaultNow(),
  latencyMs: integer('latency_ms'),
  attemptIndex: integer('attempt_index').notNull().default(0),
  errorText: text('error_text'),
}, (t) => ({
  idemKeyUq: uniqueIndex('stripe_api_call_audit_idem_uq').on(t.stripeIdempotencyKey),
  operationCalledIx: index('stripe_api_call_audit_op_called_ix').on(t.operation, t.calledAt),
  orgIx: index('stripe_api_call_audit_org_ix').on(t.organizationId, t.calledAt),
}))
```

```typescript
// packages/subscription-billing/src/schema/dunning-state.ts
// M35-F04 (ADR-0011 / ARCH-147): organization_id is a plain uuid column — no cross-module .references().
import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core'
import { subscription } from './subscription'
import { dunningStage } from './enums'

export const dunningStateRow = pgTable('dunning_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(), // logical FK to M2 organizations; RLS-governed
  subscriptionId: uuid('subscription_id').notNull().references(() => subscription.id, { onDelete: 'restrict' }),
  stage: dunningStage('stage').notNull(),
  enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
  exitedAt: timestamp('exited_at', { withTimezone: true }),
  exitReason: text('exit_reason'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  lastAttemptFailureCode: text('last_attempt_failure_code'),
  triggerInvoiceId: uuid('trigger_invoice_id'),
}, (t) => ({
  subStageIx: index('dunning_state_sub_stage_ix').on(t.subscriptionId, t.stage),
  openDunningIx: index('dunning_state_open_ix').on(t.subscriptionId)
    .where(sql`exited_at IS NULL`),
}))
```

```typescript
// packages/subscription-billing/src/schema/revenue-recognition-snapshot.ts
// Platform-shared. Cross-tenant aggregate.
import { pgTable, uuid, text, bigint, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const revenueRecognitionSnapshot = pgTable('revenue_recognition_snapshot', {
  id: uuid('id').primaryKey().defaultRandom(),
  snapshotMonth: text('snapshot_month').notNull(),                                    // 'YYYY-MM'
  mrrCents: bigint('mrr_cents', { mode: 'number' }).notNull(),
  arrCents: bigint('arr_cents', { mode: 'number' }).notNull(),
  newMrrCents: bigint('new_mrr_cents', { mode: 'number' }).notNull(),
  expansionMrrCents: bigint('expansion_mrr_cents', { mode: 'number' }).notNull(),
  contractionMrrCents: bigint('contraction_mrr_cents', { mode: 'number' }).notNull(),
  churnMrrCents: bigint('churn_mrr_cents', { mode: 'number' }).notNull(),
  activeSubscriptions: integer('active_subscriptions').notNull(),
  trialingSubscriptions: integer('trialing_subscriptions').notNull(),
  pastDueSubscriptions: integer('past_due_subscriptions').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  monthUq: uniqueIndex('revenue_recognition_snapshot_month_uq').on(t.snapshotMonth),
}))
```

```typescript
// packages/subscription-billing/src/schema/promo-code.ts
// Platform-shared. Mirror of Stripe coupon + promotion code.
import { pgTable, uuid, text, integer, bigint, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { promoKind, promoDuration } from './enums'

export const promoCode = pgTable('promo_code', {
  id: uuid('id').primaryKey().defaultRandom(),
  stripeCouponId: text('stripe_coupon_id').notNull(),
  stripePromotionCodeId: text('stripe_promotion_code_id').notNull(),
  code: text('code').notNull(),                                                       // human-readable, case-insensitive
  kind: promoKind('kind').notNull(),
  percentOff: integer('percent_off'),
  fixedOffCents: bigint('fixed_off_cents', { mode: 'number' }),
  duration: promoDuration('duration').notNull(),
  durationInMonths: integer('duration_in_months'),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validTo: timestamp('valid_to', { withTimezone: true }),
  maxRedemptions: integer('max_redemptions'),
  redemptionCount: integer('redemption_count').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUq: uniqueIndex('promo_code_code_uq').on(t.code),
  stripeCouponUq: uniqueIndex('promo_code_stripe_coupon_uq').on(t.stripeCouponId),
  stripePromoUq: uniqueIndex('promo_code_stripe_promo_uq').on(t.stripePromotionCodeId),
}))
```

```typescript
// packages/subscription-billing/src/schema/promo-code-application.ts
// M35-F04 (ADR-0011 / ARCH-147): organization_id and applied_by_membership_id are plain uuid
// columns (logical FKs, RLS-governed). M35 must NOT import M1/M2 `organizations` or
// `memberships` Drizzle schemas. Membership identity is resolved via MembershipReader seam
// and request context; the FK is logically enforced by the M1 RLS/tenancy helper.
import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { subscription } from './subscription'
import { promoCode } from './promo-code'

export const promoCodeApplication = pgTable('promo_code_application', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(), // logical FK to M2 organizations; RLS-governed
  subscriptionId: uuid('subscription_id').notNull().references(() => subscription.id, { onDelete: 'restrict' }),
  promoCodeId: uuid('promo_code_id').notNull().references(() => promoCode.id, { onDelete: 'restrict' }),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  appliedByMembershipId: uuid('applied_by_membership_id').notNull(), // logical FK to M2 memberships; resolved via MembershipReader seam
  startedAt: timestamp('started_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason'),
  m4AuditEventId: uuid('m4_audit_event_id'),
}, (t) => ({
  subActiveUq: uniqueIndex('promo_code_application_sub_active_uq')
    .on(t.subscriptionId, t.promoCodeId)
    .where(sql`revoked_at IS NULL`),
}))
```

```typescript
// packages/subscription-billing/src/schema/refund.ts
// M35-F04 (ADR-0011 / ARCH-147): organization_id and all membership_id columns are plain uuid
// columns (logical FKs, RLS-governed). M35 must NOT import M1/M2 `organizations` or
// `memberships` Drizzle schemas. Membership identity is resolved via MembershipReader seam
// and request context; the FK is logically enforced by the M1 RLS/tenancy helper.
import { pgTable, uuid, text, bigint, timestamp, check, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { invoice } from './invoice'
import { refundStatus, refundKind } from './enums'

export const refund = pgTable('refund', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(), // logical FK to M2 organizations; RLS-governed
  invoiceId: uuid('invoice_id').notNull().references(() => invoice.id, { onDelete: 'restrict' }),
  stripeRefundId: text('stripe_refund_id'),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  kind: refundKind('kind').notNull(),
  reasonCode: text('reason_code').notNull(),                                          // 'duplicate', 'fraudulent', 'requested_by_customer', 'other'
  reasonDetail: text('reason_detail').notNull(),                                       // free text, ≥40 chars
  requestedByMembershipId: uuid('requested_by_membership_id').notNull(), // logical FK to M2 memberships; resolved via MembershipReader seam
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  approvedByMembershipId: uuid('approved_by_membership_id'), // logical FK to M2 memberships; resolved via MembershipReader seam
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approverStepUpAuditEventId: uuid('approver_step_up_audit_event_id'),
  deniedByMembershipId: uuid('denied_by_membership_id'), // logical FK to M2 memberships; resolved via MembershipReader seam
  deniedAt: timestamp('denied_at', { withTimezone: true }),
  deniedReason: text('denied_reason'),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  status: refundStatus('status').notNull().default('requested'),
  stripeFailureCode: text('stripe_failure_code'),
}, (t) => ({
  invoiceIx: index('refund_invoice_ix').on(t.invoiceId),
  statusIx: index('refund_status_ix').on(t.status),
  reasonDetailMinLen: check('refund_reason_detail_min_len', sql`length(reason_detail) >= 40`),
  amountPositive: check('refund_amount_positive', sql`amount_cents > 0`),
}))
```

### 3.4 Critical Indexes (Beyond PKs and Partition Keys)

- `subscription_org_active_uq` — partial unique on `(organization_id) WHERE status NOT IN ('canceled', 'paused')` — enforces one-active-subscription-per-org.
- `payment_method_org_default_uq` — partial unique on `(organization_id) WHERE is_default = true AND is_active = true` — enforces one-default-per-org.
- `usage_event_source_dedup_uq` — partial unique on `(organization_id, source_module, source_event_id) WHERE source_event_id IS NOT NULL` — enforces idempotent ingest.
- `usage_period_aggregate_uq` — unique on `(subscription_id, event_type, period_start, period_end)` — enforces one-aggregate-per-period.
- `usage_period_aggregate_unposted_ix` — partial index on `(computed_at) WHERE stripe_usage_record_id IS NULL` — drives the `stripe-usage-posting` cron's worklist query.
- `patient_active_period_uq` and `user_active_period_uq` — idempotent pseudonym-ingest.
- `stripe_webhook_event_unprocessed_ix` — partial on `(received_at) WHERE processed_at IS NULL` — drives the webhook handler's worklist.
- `dunning_state_open_ix` — partial on `(subscription_id) WHERE exited_at IS NULL` — drives the `dunning-engine` cron's worklist.
- `subscription_period_end_ix` — drives the period-close detection cron.
- `invoice_org_status_ix` and `invoice_number_ix` — tenant invoice list views.

### 3.5 RLS Policy Pattern

All tenant-scoped tables use the standard M1 RLS pattern:

```sql
ALTER TABLE subscription ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_tenant_isolation ON subscription
  FOR ALL
  USING (organization_id = current_setting('app.org_id')::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id')::uuid);

CREATE POLICY subscription_platform_admin_bypass ON subscription
  FOR ALL
  USING (current_setting('app.tenant_scope', true) IN ('PLATFORM', 'PLATFORM_RO'))
  WITH CHECK (current_setting('app.tenant_scope', true) = 'PLATFORM');
```

Identical pattern for `subscription_state_history`, `payment_method`, `invoice`, `invoice_line`, `usage_event` (and all monthly partitions), `usage_period_aggregate`, `patient_active_period`, `user_active_period`, `dunning_state`, `promo_code_application`, `refund`.

The platform-shared tables (`plan`, `plan_meter`, `promo_code`, `revenue_recognition_snapshot`, `patient_pseudonym_key`) have a different policy:

```sql
ALTER TABLE plan ENABLE ROW LEVEL SECURITY;

CREATE POLICY plan_read_all ON plan
  FOR SELECT
  USING (true);                                                                       -- everyone reads the catalog

CREATE POLICY plan_write_platform_only ON plan
  FOR INSERT, UPDATE, DELETE
  USING (current_setting('app.tenant_scope', true) = 'PLATFORM')
  WITH CHECK (current_setting('app.tenant_scope', true) = 'PLATFORM');
```

Same pattern for `plan_meter` and `promo_code` (universal read; platform-only write). `revenue_recognition_snapshot` is platform-only read (PLATFORM or PLATFORM_RO) — cross-tenant aggregate is not exposed to tenants. `patient_pseudonym_key` is platform-only read+write — never exposed to tenant queries.

The Stripe audit tables (`stripe_webhook_event`, `stripe_api_call_audit`) are platform-only — they may carry data spanning multiple tenants in one row.

### 3.6 Audit Integration with M4 (ADR-0144 / ARCH-281#5)

> **M35-F05 fix (ADR-0144 / ARCH-281#5):** M35 does NOT own or redefine the audit-trigger
> denylist. High-volume trigger-suppression decisions belong exclusively to M4. M35's
> obligation is to (a) call M4's `audit()` / `auditRead()` helpers on every state-mutating
> route, and (b) register each owned table with M4's `AuditDenylistRegistry` at boot via
> `registerAuditPosture(table, posture)`, supplying M35's *requested* posture as advisory
> input. M4 is the decision-maker; if M4's denylist policy changes, M35 adapts automatically.
> The field-exclusion hints and high-volume exclusions below are M35's *advisory registrations*,
> not M35-owned overrides.

All M35 state-mutating routes call `m4.audit(ctx)` (write) or `m4.auditRead(ctx)` (sensitive
reads). M35 additionally registers per-table posture hints with M4's `AuditDenylistRegistry`
at boot (`register-eraser.ts` → `registerAuditPostures()`). M4 applies, may modify, or may
override these hints as its own policy requires. The hint table below documents M35's intent:

| Table | M35's advisory posture registered with M4 |
|---|---|
| `subscription` | Request audit on every UPDATE; field-exclusion hint: `stripe_*` fields (high-churn Stripe metadata) |
| `subscription_state_history` | Request full table exclusion (it IS the audit trail; M4 audit of it would be recursive) |
| `payment_method` | Request audit on UPDATE/DELETE; field-exclusion hint: `card_*`, `ach_*`, `sepa_*` columns (metadata-only but defence-in-depth) |
| `invoice` | Request audit on UPDATE (status transitions); field-exclusion hint: `hosted_invoice_url`, `invoice_pdf_url` (guessable Stripe URL structure) |
| `invoice_line` | Request audit on INSERT; UPDATE rare; no exclusion hint |
| `usage_event` | Request full table exclusion (high volume; append-only; `stripe_api_call_audit` is the canonical usage-flow trail) |
| `usage_period_aggregate` | Request partial exclusion: audit only when `stripe_usage_record_id` is set; otherwise exclude |
| `patient_active_period` | Request full table exclusion (append-only pseudonym rows; M35-internal eraser handles destruction) |
| `user_active_period` | Same as `patient_active_period` |
| `stripe_webhook_event` | Request full table exclusion (it IS the source-of-truth log) |
| `stripe_api_call_audit` | Request full table exclusion (it IS the audit ledger) |
| `dunning_state` | Request audit on stage transitions |
| `revenue_recognition_snapshot` | Request full table exclusion (append-only platform-shared aggregate) |
| `promo_code` | Request audit on UPDATE (platform-admin actions) |
| `promo_code_application` | Request audit on INSERT and on `revoked_at` UPDATE |
| `refund` | Request audit on every status transition; `approver_step_up_audit_event_id` links to M2's step-up audit row |
| `plan` | Request audit on every UPDATE (platform-admin actions) |
| `plan_meter` | Request audit on UPDATE |
| `patient_pseudonym_key` | Request full table exclusion (key-rotation timeline must not appear in the audit log); M4's table-level access log records operator access separately |

M4 owns whether trigger suppression is granted for each table. M35's `registerAuditPostures()`
call runs at boot alongside `registerSeams()` and `validateSeams()`; M4 validates the
registrations and refuses startup if a mandatory hint field is missing.

### 3.7 Eraser Registration (M4 Destruction Workflow)

> **M35-F06 fix (ARCH-186/085/251):** The previous approach rewrote `organization_id`
> in-place to a `legacy_tenant_<sha256(orgId)>` placeholder string on the live `invoice`
> table rows. This is structurally unsafe: it corrupts the FK value that RLS and all
> downstream readers depend on, and "survived" only because the tenant RLS policy had
> already been torn down at that point. The replacement approach is a first-class
> **`platform_retained_invoice`** table (declared in M35's `ownedTables` — see manifest
> patch note at the end of this section) that accepts invoice rows transferred out of
> the tenant-scoped `invoice` table. The transfer is a copy-then-delete, not an in-place
> rewrite. `platform_retained_invoice` carries its own `original_organization_id` column
> (for forensic/regulatory traceability) without being RLS-tenant-scoped. M4's
> destruction-certification step and M34's offboarding orchestration both consume the
> updated `EraseReceipt` to confirm platform-retention rows were moved, not deleted.

M35 registers a `DataEraser` implementation with M4 for tenant offboarding. The eraser behavior:

```typescript
// packages/subscription-billing/src/boot/register-eraser.ts
export class M35DataEraser implements DataEraser {
  moduleId = 'm35-subscription-billing'

  async eraseTenantData(organizationId: string, tx: DBTransaction): Promise<EraseReceipt> {
    // 1. Cancel the active Stripe subscription (best-effort; do not block erasure on Stripe failure)
    //    The Stripe-side subscription is also canceled by the m2.organization.closed handler;
    //    this is defense-in-depth.
    await this.cancelStripeSubscription(organizationId)

    // 2. PRESERVE platform-retention rows FIRST (before deleting tenant rows):
    //    Copy invoice + invoice_line rows into platform_retained_invoice /
    //    platform_retained_invoice_line (platform-retention tables, not tenant-scoped).
    //    These rows carry `original_organization_id` for forensic/regulatory traceability.
    //    After the copy succeeds, delete the source rows from the tenant-scoped tables.
    //    This is a copy-then-delete, NOT an in-place organization_id rewrite.
    //    Integrated with M4's destruction-certification (M4 receives the platform_retention_ids
    //    in the EraseReceipt) and M34's offboarding orchestration.

    const retentionResult = await this.transferInvoicesToPlatformRetention(organizationId, tx)

    // 3. Delete remaining tenant-scoped rows in FK order:
    //    refund → promo_code_application → user_active_period → patient_active_period →
    //    usage_period_aggregate → usage_event (partitioned) → dunning_state →
    //    subscription_state_history → subscription → payment_method
    //    (invoice + invoice_line already moved to platform_retained_* in step 2)

    const counts = await this.deleteTenantRows(organizationId, tx)

    // 4. Stripe Customer remains at Stripe (Stripe-side retention) but is marked
    //    as `metadata.wardenx_tenant_erased=true` so it's filtered out of operational views.

    return {
      moduleId: this.moduleId,
      organizationId,
      tablesErased: counts,
      tablesPreservedInPlatformRetention: retentionResult.transferredIds,
      platformRetentionTables: ['platform_retained_invoice', 'platform_retained_invoice_line'],
      stripeCustomerStatus: 'tagged_erased',
      erasedAt: new Date(),
    }
  }
}
```

**Platform-retention table schema (sketch):**

```typescript
// packages/subscription-billing/src/schema/platform-retained-invoice.ts
// Platform-only. NOT tenant-scoped (no RLS organization_id policy).
// Holds invoice rows transferred from the tenant-scoped `invoice` table on tenant offboarding.
// 7-year IRS §6001 retention floor per D13.
// M35-F06 (ARCH-186/085/251): replaces the unsafe in-place organization_id rewrite.
export const platformRetainedInvoice = pgTable('platform_retained_invoice', {
  id: uuid('id').primaryKey().defaultRandom(),
  originalInvoiceId: uuid('original_invoice_id').notNull(),         // PK from the source invoice row
  originalOrganizationId: uuid('original_organization_id').notNull(), // forensic traceability only
  transferredAt: timestamp('transferred_at', { withTimezone: true }).notNull().defaultNow(),
  retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(), // original_transferred_at + 7 years
  // ... all invoice payload columns copied verbatim (stripeInvoiceId, status, totals, dates, urls, etc.)
  stripeInvoiceId: text('stripe_invoice_id').notNull(),
  invoiceNumber: text('invoice_number'),
  status: invoiceStatus('status').notNull(),
  subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull(),
  taxCents: bigint('tax_cents', { mode: 'number' }).notNull(),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
  amountPaidCents: bigint('amount_paid_cents', { mode: 'number' }).notNull(),
  currencyCode: text('currency_code').notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
})

// Companion: platform_retained_invoice_line — line rows transferred from the tenant-scoped
// `invoice_line` table alongside their parent invoice on tenant offboarding.
// Platform-only. NOT tenant-scoped (no RLS organization_id policy).
// 7-year IRS §6001 retention floor per D13. M35-F06 (ARCH-186/085/251).
export const platformRetainedInvoiceLine = pgTable('platform_retained_invoice_line', {
  id: uuid('id').primaryKey().defaultRandom(),
  originalInvoiceLineId: uuid('original_invoice_line_id').notNull(),       // PK from the source invoice_line row
  retainedInvoiceId: uuid('retained_invoice_id').notNull()                 // parent platform_retained_invoice row
    .references(() => platformRetainedInvoice.id, { onDelete: 'restrict' }),
  originalInvoiceId: uuid('original_invoice_id').notNull(),                 // source invoice PK (forensic cross-ref)
  originalOrganizationId: uuid('original_organization_id').notNull(),      // forensic traceability only
  transferredAt: timestamp('transferred_at', { withTimezone: true }).notNull().defaultNow(),
  retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(), // original_transferred_at + 7 years
  // ... all invoice_line payload columns copied verbatim (no .references() to tenant-scoped tables)
  stripeLineId: text('stripe_line_id').notNull(),
  kind: invoiceLineKind('kind').notNull(),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull().default(1),
  unitAmountCents: bigint('unit_amount_cents', { mode: 'number' }).notNull().default(0),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
  periodStart: timestamp('period_start', { withTimezone: true }),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  meterEventType: usageEventType('meter_event_type'),
}, (t) => ({
  retainedInvoiceIx: index('platform_retained_invoice_line_invoice_ix').on(t.retainedInvoiceId),
}))
```

> **Manifest ownedTables impact (flagged — do not edit the manifest here):** The two new
> platform-retention tables (`platform_retained_invoice`, `platform_retained_invoice_line`)
> must be added to `M35.ownedTables` in `architecture/module-manifest.ts`. The §13 manifest
> patch currently lists 19 tables; after this fix it should list 21. The manifest update
> must accompany the Phase 2 implementation of M35-F06 (T-36 or a new T-36a task). Track
> this in the acceptance checklist (§12.2).

Boot validator (`validateErasers()` in M4) asserts that every M35-owned tenant-scoped table has a corresponding entry in the eraser plan, and that the `EraseReceipt.platformRetentionTables` list matches the registered platform-retention tables.

-----

## 4. API Routes, Seams & Backend Surface

### 4.1 Route Inventory — Tenant Surface (`/api/v1`)

| Method | Path | Purpose | Permission | Step-up |
|---|---|---|---|---|
| `GET` | `/v1/plans` | List active plans (unauthenticated; marketing pages) | none | no |
| `GET` | `/v1/subscription` | Read current subscription state | `subscription.read` | no |
| `POST` | `/v1/subscription` | Create subscription (one-time op; selects plan) | `subscription.create` | yes |
| `PATCH` | `/v1/subscription` | Change plan (upgrade/downgrade) | `subscription.update` | yes |
| `POST` | `/v1/subscription/cancel` | Cancel at period end | `subscription.cancel` | yes |
| `POST` | `/v1/subscription/resume` | Resume after pause | `subscription.update` | yes |
| `POST` | `/v1/subscription/apply_promo` | Apply a publicly-visible promo code | `subscription.update` | no |
| `GET` | `/v1/payment_methods` | List tenant's payment methods | `payment_method.read` | no |
| `POST` | `/v1/payment_methods/setup_intent` | Create Stripe SetupIntent (returns client_secret) | `payment_method.write` | yes |
| `POST` | `/v1/payment_methods/attach` | Attach a SetupIntent-completed pm to the org | `payment_method.write` | yes |
| `PATCH` | `/v1/payment_methods/:id/set_default` | Set as default | `payment_method.write` | yes |
| `DELETE` | `/v1/payment_methods/:id` | Detach (soft-delete) | `payment_method.write` | yes |
| `GET` | `/v1/invoices` | List tenant's invoices | `invoice.read` | no |
| `GET` | `/v1/invoices/:id` | Read invoice detail | `invoice.read` | no |
| `GET` | `/v1/invoices/:id/hosted_url` | Redirect to Stripe-hosted invoice page | `invoice.read` | no |
| `GET` | `/v1/invoices/:id/pdf` | Stream invoice PDF (proxied from Stripe with org check) | `invoice.read` | no |
| `GET` | `/v1/usage/current` | Current-period usage summary (totals + remaining inclusive) | `usage.read` | no |
| `GET` | `/v1/usage/history` | Historical usage by period | `usage.read` | no |
| `GET` | `/v1/billing/status` | Lightweight billing status (used by frontend chrome) | `subscription.read` | no |

### 4.2 Route Inventory — Admin / Platform-Ops Surface (`/api/admin`)

| Method | Path | Purpose | Permission | Step-up |
|---|---|---|---|---|
| `GET` | `/admin/plans` | List all plans (incl. inactive/deprecated) | `plan.admin.read` | no |
| `POST` | `/admin/plans` | Create plan (draft) | `plan.admin.write` | yes |
| `PATCH` | `/admin/plans/:id` | Update draft plan | `plan.admin.write` | yes |
| `POST` | `/admin/plans/:id/activate` | Promote to active | `plan.admin.write` | yes |
| `POST` | `/admin/plans/:id/deprecate` | Deprecate (grandfather existing) | `plan.admin.write` | yes |
| `POST` | `/admin/plans/:id/meters` | Add a meter | `plan.admin.write` | yes |
| `PATCH` | `/admin/plans/:id/meters/:meterId` | Update meter | `plan.admin.write` | yes |
| `GET` | `/admin/subscriptions` | List all subscriptions (cross-tenant) | `subscription.admin.read` | no |
| `GET` | `/admin/subscriptions/:id` | Detail of any subscription | `subscription.admin.read` | no |
| `POST` | `/admin/subscriptions/:id/pause` | Manually pause a subscription | `subscription.admin.write` | yes |
| `POST` | `/admin/subscriptions/:id/resume` | Manually resume | `subscription.admin.write` | yes |
| `POST` | `/admin/subscriptions/:id/cancel` | Cancel immediately (not at period end) | `subscription.admin.write` | yes |
| `POST` | `/admin/subscriptions/:id/apply_promo` | Apply promo code to subscription | `promo.admin.apply` | yes |
| `POST` | `/admin/subscriptions/:id/revoke_promo` | Revoke an applied promo | `promo.admin.revoke` | yes |
| `POST` | `/admin/dunning/:subscriptionId/skip_stage` | Skip a dunning stage forward | `dunning.admin.override` | yes |
| `POST` | `/admin/dunning/:subscriptionId/reset` | Reset dunning to `none` (e.g. after manual payment) | `dunning.admin.override` | yes |
| `POST` | `/admin/refunds` | Request a refund | `refund.request` | yes |
| `POST` | `/admin/refunds/:id/approve` | Approve a refund | `refund.approve` | yes |
| `POST` | `/admin/refunds/:id/deny` | Deny a refund | `refund.approve` | yes |
| `GET` | `/admin/refunds` | List refunds across tenants | `refund.read` | no |
| `GET` | `/admin/promos` | List all promo codes | `promo.admin.read` | no |
| `POST` | `/admin/promos` | Create promo | `promo.admin.write` | yes |
| `PATCH` | `/admin/promos/:id` | Update promo | `promo.admin.write` | yes |
| `POST` | `/admin/promos/:id/deactivate` | Deactivate | `promo.admin.write` | yes |
| `GET` | `/admin/revenue/snapshots` | List MRR/ARR snapshots | `revenue.admin.read` | no |
| `GET` | `/admin/revenue/current` | Live MRR estimate | `revenue.admin.read` | no |
| `POST` | `/admin/revenue/snapshots/compute` | Force recompute of current month | `revenue.admin.write` | yes |
| `GET` | `/admin/usage/:organizationId/current` | Detail tenant usage (drill-down) | `usage.admin.read` | no |
| `GET` | `/admin/webhooks/stripe/recent` | Recent webhook receipts (forensics) | `stripe.admin.read` | no |
| `POST` | `/admin/webhooks/stripe/replay/:eventId` | Replay a webhook (last-resort recovery) | `stripe.admin.replay` | yes |

### 4.3 Route Inventory — Webhook Surface

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/v1/webhooks/stripe` | Inbound Stripe webhook | Stripe-Signature HMAC verification (`STRIPE_WEBHOOK_SECRET`); no user session |

### 4.4 Representative TypeBox Schemas — Wire Contracts

```typescript
// apps/backend/src/modules/35-subscription-billing/routes/subscription.ts
import { Type } from '@sinclair/typebox'

export const SubscriptionResponseDto = Type.Object({
  id: Type.String({ format: 'uuid' }),
  organizationId: Type.String({ format: 'uuid' }),
  planSlug: Type.String(),
  planName: Type.String(),
  status: Type.Union([
    Type.Literal('trialing'), Type.Literal('active'), Type.Literal('past_due'),
    Type.Literal('at_risk'), Type.Literal('suspended'), Type.Literal('canceled'), Type.Literal('paused'),
  ]),
  trialEndsAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  currentPeriodStart: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  currentPeriodEnd: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  cancelAtPeriodEnd: Type.Boolean(),
  canceledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  defaultPaymentMethodLast4: Type.Union([Type.String(), Type.Null()]),
  defaultPaymentMethodBrand: Type.Union([Type.String(), Type.Null()]),
  defaultPaymentMethodExpiresAt: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
  dunningStage: Type.Union([
    Type.Literal('none'), Type.Literal('day_1'), Type.Literal('day_7'),
    Type.Literal('day_14'), Type.Literal('day_21'), Type.Literal('day_28_suspend'),
    Type.Literal('day_60_cancel'), Type.Literal('resolved'),
  ]),
})

export const CreateSubscriptionRequestDto = Type.Object({
  planSlug: Type.String(),
  paymentMethodId: Type.Optional(Type.String({ format: 'uuid' })),
  promoCode: Type.Optional(Type.String()),
})

export const ChangePlanRequestDto = Type.Object({
  newPlanSlug: Type.String(),
  prorationBehavior: Type.Union([
    Type.Literal('create_prorations'),
    Type.Literal('always_invoice'),
    Type.Literal('none'),
  ]),
})

export const UsageCurrentResponseDto = Type.Object({
  periodStart: Type.String({ format: 'date-time' }),
  periodEnd: Type.String({ format: 'date-time' }),
  meters: Type.Array(Type.Object({
    eventType: Type.String(),
    label: Type.String(),
    totalQuantity: Type.Integer({ minimum: 0 }),
    inclusiveQuantity: Type.Integer({ minimum: 0 }),
    overageQuantity: Type.Integer({ minimum: 0 }),
    overageUnitPriceCents: Type.Integer({ minimum: 0 }),
    projectedOverageCostCents: Type.Integer({ minimum: 0 }),
    thresholdState: Type.Union([
      Type.Literal('ok'), Type.Literal('warning'), Type.Literal('breached'),
    ]),
  })),
})

export const InvoiceListItemDto = Type.Object({
  id: Type.String({ format: 'uuid' }),
  invoiceNumber: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([
    Type.Literal('draft'), Type.Literal('open'), Type.Literal('paid'),
    Type.Literal('void'), Type.Literal('uncollectible'),
  ]),
  totalCents: Type.Integer({ minimum: 0 }),
  currencyCode: Type.String(),
  periodStart: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  periodEnd: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  issuedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  dueAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  paidAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
})

export const BillingStatusDto = Type.Object({
  status: Type.String(),
  isBlockedByBilling: Type.Boolean(),
  dunningStage: Type.String(),
  daysUntilSuspension: Type.Union([Type.Integer(), Type.Null()]),
  hasValidPaymentMethod: Type.Boolean(),
  paymentMethodExpiresAt: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
})

export const RefundRequestDto = Type.Object({
  invoiceId: Type.String({ format: 'uuid' }),
  amountCents: Type.Integer({ minimum: 1 }),
  kind: Type.Union([Type.Literal('full'), Type.Literal('partial'), Type.Literal('credit_only')]),
  reasonCode: Type.Union([
    Type.Literal('duplicate'), Type.Literal('fraudulent'),
    Type.Literal('requested_by_customer'), Type.Literal('other'),
  ]),
  reasonDetail: Type.String({ minLength: 40, maxLength: 4000 }),
})
```

### 4.5 Published Seams (`SeamRegistry`)

M35 publishes six seams at boot. Each is registered into M1's typed `SeamRegistry`; `validateSeams()` refuses startup if any seam is unregistered.

```typescript
// packages/subscription-billing/src/seams/published/subscription-state-provider.ts
export interface SubscriptionStateProvider {
  subscriptionForOrg(organizationId: string): Promise<SubscriptionState | null>
  stateHistoryForSubscription(subscriptionId: string, limit?: number): Promise<SubscriptionStateTransition[]>
  subscriptionsForTenants(organizationIds: string[]): Promise<Map<string, SubscriptionState>>
}

export interface SubscriptionState {
  id: string
  organizationId: string
  planSlug: string
  planTier: 'starter' | 'professional' | 'enterprise'
  status: 'trialing' | 'active' | 'past_due' | 'at_risk' | 'suspended' | 'canceled' | 'paused'
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  trialEndsAt: Date | null
  cancelAtPeriodEnd: boolean
}
```

```typescript
// packages/subscription-billing/src/seams/published/billing-status-provider.ts
export interface BillingStatusProvider {
  statusForOrg(organizationId: string): Promise<BillingStatus>
  statusForOrgs(organizationIds: string[]): Promise<Map<string, BillingStatus>>
  /** Quota check used by M28, M29, M32 in Phase 2. Implementations return
   *  `{ ok: true }` in Phase 1 (no quotas enforced). */
  isQuotaAvailable(input: { organizationId: string; meter: UsageEventType; requestedQuantity: number }): Promise<{ ok: boolean; reason?: string }>
}

export interface BillingStatus {
  status: SubscriptionState['status']
  isBlockedByBilling: boolean
  dunningStage: 'none' | 'day_1' | 'day_7' | 'day_14' | 'day_21' | 'day_28_suspend' | 'day_60_cancel' | 'resolved'
  daysUntilSuspension: number | null
  hasValidPaymentMethod: boolean
  paymentMethodExpiresAt: Date | null
}
```

```typescript
// packages/subscription-billing/src/seams/published/usage-metering-ingest.ts
export interface UsageMeteringIngest {
  /** Ingest a single usage event. Idempotent on (organizationId, sourceModule, sourceEventId).
   *  PHI-free metadata is enforced — the redactor will refuse a payload containing fields
   *  that match the PHI denylist (patient_id, mrn, name, dob, ssn, address, ...). */
  ingest(input: {
    organizationId: string
    eventType: UsageEventType
    quantity: number
    sourceModule: 'm1' | 'm2' | 'm5' | 'm23' | 'm24' | 'm28' | 'm29' | 'm32'
    sourceEventId?: string
    metadataRedacted?: Record<string, string | number | boolean>
    recordedAt?: Date
  }): Promise<{ accepted: boolean; deduped: boolean; reason?: string }>

  ingestBatch(input: { events: UsageEventInput[] }): Promise<{ acceptedCount: number; dedupedCount: number; rejectedCount: number; rejections: UsageEventRejection[] }>
}
```

```typescript
// packages/subscription-billing/src/seams/published/patient-counter-provider.ts
export interface PatientCounterProvider {
  /** Returns the count of active patients in the period (reads patient_active_period,
   *  which is pseudonymized — so the count is over distinct patient_pseudonyms with
   *  was_active=true in the period). M5 exposes the equivalent count via
   *  PatientReader.countActiveForOrg; the two should agree, and a reconciler
   *  alert fires if they disagree by >1%. */
  activePatientCountForPeriod(input: {
    organizationId: string
    periodStart: Date
    periodEnd: Date
  }): Promise<number>
}
```

```typescript
// packages/subscription-billing/src/seams/published/revenue-metrics-provider.ts
// Platform-shared. Consumed by M33 reporting for the platform-ops revenue dashboard.
export interface RevenueMetricsProvider {
  currentMonthMrrCents(): Promise<number>
  mrrSnapshotForMonth(yearMonth: string): Promise<RevenueRecognitionSnapshot | null>
  mrrSnapshotsForRange(input: { fromYearMonth: string; toYearMonth: string }): Promise<RevenueRecognitionSnapshot[]>
  subscriptionStatusCounts(): Promise<Record<SubscriptionState['status'], number>>
}
```

```typescript
// packages/subscription-billing/src/seams/published/plan-catalog-reader.ts
// Public read. No authentication required (used by marketing pages and onboarding).
export interface PlanCatalogReader {
  listActivePlans(): Promise<PlanCatalogEntry[]>
  planBySlug(slug: string): Promise<PlanCatalogEntry | null>
}

export interface PlanCatalogEntry {
  slug: string
  name: string
  description: string
  tier: 'starter' | 'professional' | 'enterprise'
  cadence: 'monthly' | 'annual'
  basePriceCents: number
  currencyCode: string
  trialPeriodDays: number
  meters: Array<{
    eventType: UsageEventType
    label: string
    inclusiveQuantity: number
    overageUnitPriceCents: number
    billingAggregation: 'sum' | 'last' | 'count'
  }>
}
```

### 4.6 Consumed Seams

| Seam | Source module | Phase 1 wiring | Phase 2 wiring |
|---|---|---|---|
| `OrganizationReader.organizationById` | M2 | real (M2 is locked) | real |
| `MembershipReader.activeMembershipsForOrg` | M2 | real | real |
| `AlertEmitter.emit` | M36 | real (M36 is locked) | real |
| `TerminologyProvider.validateCode` (currency_code ISO 4217) | M38 | real (M38 is locked) | real |
| M1 outbox + idempotency helpers | M1 | real | real |
| M4 `auditEvent` | M4 | real | real |
| `m5.patient.created`, `m5.patient.status_changed`, `m5.patient.deceased`, `m5.patient.merged` outbox subscription | M5 | real (M5 is locked) | real |
| `m2.session.created` outbox subscription | M2 | real | real |
| `m2.organization.activated`, `m2.organization.suspended`, `m2.organization.closed` outbox subscription | M2 | real | real |
| `FhirGatewayMetricsProvider.disclosureMetricsForOrg` | M28 | (M35 doesn't ship in Phase 1) | real (M28 is locked) |
| `ExternalInterfaceMetricsProvider.feedHealthForOrg` (HL7 message counts) | M29 | (M35 doesn't ship in Phase 1) | real (M29 is locked) |
| `AITokenMeterProvider.tokensConsumedForOrg` | M32 | **forward-seam deny-stub** (M32 not yet locked) | real when M32 locks |
| `OnboardingStatusProvider.isBillableForOrg` | M34 | **forward-seam deny-stub** (M34 not yet locked) | real when M34 locks |

The two forward-seam deny-stubs ship at M35 lock as `NotImplementedError`-throwing placeholders registered in the seam registry so `validateSeams()` passes; the real implementations land when M32 and M34 lock. The interim posture for `OnboardingStatusProvider` is "every org with `Organization.status='active'` is billable" — a strictly safer default than the M34-aware behavior (M34 will likely *narrow* billability to "active AND onboarding-complete").

### 4.7 Permission Keys Registered into Module 3

```typescript
// packages/subscription-billing/src/boot/register-permissions.ts
import { permissionRegistry } from '@wardenx/authorization'

const M35_PERMISSIONS = [
  // Tenant surface:
  { key: 'subscription.read',        label: 'Read subscription',              defaultRoles: ['org_admin', 'billing_admin', 'accounts_receivable'] },
  { key: 'subscription.create',      label: 'Create subscription',            defaultRoles: ['org_admin'] },
  { key: 'subscription.update',      label: 'Change plan',                     defaultRoles: ['org_admin'] },
  { key: 'subscription.cancel',      label: 'Cancel subscription',             defaultRoles: ['org_admin'] },
  { key: 'payment_method.read',      label: 'View payment methods',            defaultRoles: ['org_admin', 'billing_admin', 'accounts_receivable'] },
  { key: 'payment_method.write',     label: 'Manage payment methods',          defaultRoles: ['org_admin', 'billing_admin'] },
  { key: 'invoice.read',             label: 'Read invoices',                   defaultRoles: ['org_admin', 'billing_admin', 'accounts_receivable'] },
  { key: 'usage.read',               label: 'View usage',                      defaultRoles: ['org_admin', 'billing_admin', 'accounts_receivable'] },

  // Platform-admin surface:
  { key: 'plan.admin.read',          label: 'Read plan catalog (admin)',       defaultRoles: ['platform_admin', 'platform_billing_admin'] },
  { key: 'plan.admin.write',         label: 'Modify plan catalog',             defaultRoles: ['platform_admin'] },
  { key: 'subscription.admin.read',  label: 'Read any subscription',           defaultRoles: ['platform_admin', 'platform_billing_admin', 'platform_support_t2'] },
  { key: 'subscription.admin.write', label: 'Modify any subscription',         defaultRoles: ['platform_admin', 'platform_billing_admin'] },
  { key: 'dunning.admin.override',   label: 'Override dunning state',          defaultRoles: ['platform_admin'] },
  { key: 'refund.request',           label: 'Request a refund',                defaultRoles: ['platform_admin', 'platform_billing_admin'] },
  { key: 'refund.approve',           label: 'Approve / deny a refund',         defaultRoles: ['platform_admin'] },
  { key: 'refund.read',              label: 'Read refund records',             defaultRoles: ['platform_admin', 'platform_billing_admin'] },
  { key: 'promo.admin.read',         label: 'Read promo catalog',              defaultRoles: ['platform_admin', 'platform_billing_admin', 'platform_sales'] },
  { key: 'promo.admin.write',        label: 'Modify promo catalog',            defaultRoles: ['platform_admin'] },
  { key: 'promo.admin.apply',        label: 'Apply promo to a subscription',   defaultRoles: ['platform_admin', 'platform_billing_admin'] },
  { key: 'promo.admin.revoke',       label: 'Revoke applied promo',            defaultRoles: ['platform_admin'] },
  { key: 'revenue.admin.read',       label: 'Read MRR/ARR snapshots',          defaultRoles: ['platform_admin', 'platform_billing_admin', 'platform_owner'] },
  { key: 'revenue.admin.write',      label: 'Recompute MRR/ARR',               defaultRoles: ['platform_admin'] },
  { key: 'usage.admin.read',         label: 'Read any tenant usage',           defaultRoles: ['platform_admin', 'platform_billing_admin', 'platform_support_t2'] },
  { key: 'stripe.admin.read',        label: 'Read Stripe webhook log',         defaultRoles: ['platform_admin', 'platform_billing_admin'] },
  { key: 'stripe.admin.replay',      label: 'Replay a Stripe webhook',         defaultRoles: ['platform_admin'] },
]

for (const p of M35_PERMISSIONS) permissionRegistry.declare(p)
```

Two new tenant-side roles are introduced by M35: `billing_admin` (Treasury/finance contact for the agency; not a clinical role) and `accounts_receivable` (AR clerk who reads invoices but cannot modify payment methods or subscription).

Platform-ops roles consumed by M35 (defined in M2 / M34 platform-ops scope): `platform_owner`, `platform_admin`, `platform_billing_admin`, `platform_support_t2`, `platform_sales`. The role-key catalog is platform-owned.

### 4.8 ABAC Predicates Registered with M3

M35 introduces five new ABAC predicates registered into M3's named-predicate registry. Boot-validated: a missing predicate binding refuses startup.

```typescript
// packages/subscription-billing/src/boot/register-predicates.ts
import { predicateRegistry } from '@wardenx/authorization'

predicateRegistry.declare('billing_scope_matches_org', async (ctx, target) => {
  return ctx.organizationId === target.organizationId
})

predicateRegistry.declare('platform_billing_scope', async (ctx, _target) => {
  return ctx.tenantScope === 'PLATFORM'
})

predicateRegistry.declare('refund_requires_step_up_approval', async (ctx, target) => {
  // Refund approval requires a fresh (≤5min) step-up auth token AND the approver
  // must be different from the requester (4-eyes).
  if (!ctx.stepUpToken || ctx.stepUpFreshSecs > 300) return false
  if (ctx.membershipId === target.requestedByMembershipId) return false
  return true
})

predicateRegistry.declare('plan_change_within_period_grace', async (ctx, target) => {
  // Outside the 7-day grace window, only platform_admin may pass 'always_invoice'.
  if (target.prorationBehavior !== 'always_invoice') return true
  const periodStart = target.subscription.currentPeriodStart
  const sevenDays = 7 * 24 * 3600 * 1000
  if (periodStart && Date.now() - periodStart.getTime() <= sevenDays) return true
  return ctx.roleKeys.includes('platform_admin')
})

predicateRegistry.declare('promo_applicable_to_subscription', async (_ctx, target) => {
  // Predicate-side validation: the promo must be active, within its validity window,
  // not already applied to this subscription, and the subscription must be in a
  // promo-eligible state (active or trialing).
  const promo = target.promo
  if (!promo.isActive) return false
  const now = new Date()
  if (promo.validFrom && now < promo.validFrom) return false
  if (promo.validTo && now > promo.validTo) return false
  if (promo.maxRedemptions && promo.redemptionCount >= promo.maxRedemptions) return false
  if (!['active', 'trialing'].includes(target.subscription.status)) return false
  if (target.alreadyApplied) return false
  return true
})
```

### 4.9 BullMQ Queue Catalog

| Queue | Concurrency | Trigger | Purpose |
|---|---|---|---|
| `m35.stripe-dispatcher` | 5 per worker | drain of `m35.stripe.*` outbox events | outbound Stripe API calls (idempotency-keyed) |
| `m35.stripe-webhook-handler` | 10 per worker | drain of `m35.stripe.webhook_received` | process verified webhook events; update mirrors |
| `m35.usage-aggregator` | 1 per tenant (key: `organizationId`) | hourly cron + post-event | roll `usage_event` → `usage_period_aggregate` |
| `m35.stripe-usage-posting` | 5 per worker | daily cron | post `usage_period_aggregate` → Stripe `usage_record` |
| `m35.subscription-reconciler` | 1 per tenant (key: `organizationId`) | hourly cron + webhook trigger | reconcile WardenX ↔ Stripe state |
| `m35.dunning-engine` | 1 per tenant (key: `organizationId`) | daily cron at 09:00 tenant-tz | advance dunning state machine |
| `m35.revenue-snapshot` | 1 per worker (singleton) | monthly cron on 1st at 00:30 UTC | compute MRR/ARR snapshot |
| `m35.patient-active-period-aggregator` | 1 per tenant (key: `organizationId`) | drain of `m5.patient.*` events | pseudonymize + update `patient_active_period` |
| `m35.user-active-period-aggregator` | 1 per tenant (key: `organizationId`) | drain of `m2.session.created` events | pseudonymize + update `user_active_period` |
| `m35.payment-method-expiry-watch` | 1 per worker (singleton) | daily cron at 08:00 UTC | scan for expiring payment methods; emit alerts |
| `m35.org-lifecycle-handler` | 1 per tenant | drain of `m2.organization.*` events | pause / cancel Stripe subscription on org lifecycle transitions |

All consumer-style queues are idempotent on `(event_id, target_id)` so redelivery is a no-op; cron-style queues use `SKIP LOCKED` to prevent inter-tenant contention.

### 4.9.1 — M35-F07: Queue Retry / Backoff / DLQ Parameters (ARCH-262, SD-059, OPS-035)

Every M35 BullMQ queue declares its full operational parameters. No queue ships with undeclared retry or DLQ semantics. All queues assert idempotent consumers (redelivery is a no-op for every handler). DLQ policy: a job that exhausts all attempts moves to the named DLQ; the DLQ must be **documented before being cleared** — every DLQ clear requires an ops-runbook entry referencing the incident or the reason (OPS-035). The monitoring alert for each DLQ is defined in §9.10.

| Queue | `priority` | `attempts` | Backoff | `concurrency` | DLQ name | DLQ triage |
|---|---|---|---|---|---|---|
| `m35.stripe-dispatcher` | 1 (high) | 6 | Exponential, delay 2s, factor 2 (2s → 4s → 8s → 16s → 32s → 64s) | 5 per worker | `m35.stripe-dispatcher.dlq` | Each DLQ job maps to a `stripe_api_call_audit` row; triage via `/admin/webhooks/stripe`; confirm Stripe-side state before retrying or abandoning; document disposition in incident log before `bull dlq clear`. |
| `m35.stripe-webhook-handler` | 2 | 5 | Exponential, delay 1s, factor 2 (1s → 2s → 4s → 8s → 16s) | 10 per worker | `m35.stripe-webhook-handler.dlq` | Each DLQ job references a `stripe_webhook_event.id`; inspect `error_text`; replay via `/admin/webhooks/stripe/replay/:eventId` (requires `stripe.admin.replay`); document before clear. |
| `m35.usage-aggregator` | 3 | 4 | Exponential, delay 5s, factor 2 (5s → 10s → 20s → 40s) | 1 per tenant | `m35.usage-aggregator.dlq` | DLQ failure = usage period may under-count for the affected tenant; check `usage_event` table for the failed org + period; re-trigger aggregation after fix; document before clear. |
| `m35.stripe-usage-posting` | 3 | 5 | Exponential, delay 30s, factor 2 (30s → 60s → 120s → 240s → 480s) | 5 per worker | `m35.stripe-usage-posting.dlq` | DLQ failure = Stripe `usage_record` not posted for a period; check `usage_period_aggregate.stripe_usage_record_id` (null means unposted); re-post via cron re-trigger; reconciler cron will flag drift; document before clear. |
| `m35.subscription-reconciler` | 4 | 3 | Fixed, delay 60s | 1 per tenant | `m35.subscription-reconciler.dlq` | DLQ failure = a tenant's reconciler is stuck; inspect Stripe API availability; manual reconcile via `/admin/subscriptions/:id` if Stripe is back; flag subscription for manual review if drift persists; document before clear. |
| `m35.dunning-engine` | 4 | 3 | Exponential, delay 60s, factor 2 (60s → 120s → 240s) | 1 per tenant | `m35.dunning-engine.dlq` | DLQ failure = dunning stage may not advance for that tenant that day; the next day's cron will re-run; check `dunning_state` for the affected subscription; escalate to `platform_admin` if the subscription should have suspended; document before clear. |
| `m35.revenue-snapshot` | 5 | 2 | Fixed, delay 300s | 1 (singleton) | `m35.revenue-snapshot.dlq` | Singleton; on DLQ trigger `/admin/revenue/snapshots/compute` (requires `revenue.admin.write`) to manually recompute the month; document before clear. |
| `m35.patient-active-period-aggregator` | 3 | 5 | Exponential, delay 2s, factor 2 | 1 per tenant | `m35.patient-active-period-aggregator.dlq` | DLQ failure = a patient's pseudonym ingest was lost for the affected period; if the source event is still in M5's outbox, replay is possible; otherwise compute pseudonym manually from M5 data under forensic protocol (platform_admin); document before clear. |
| `m35.user-active-period-aggregator` | 3 | 5 | Exponential, delay 2s, factor 2 | 1 per tenant | `m35.user-active-period-aggregator.dlq` | Same as patient aggregator; source event is `m2.session.created`; replay from M2 outbox if available; document before clear. |
| `m35.payment-method-expiry-watch` | 5 | 2 | Fixed, delay 300s | 1 (singleton) | `m35.payment-method-expiry-watch.dlq` | Singleton; failure means the daily scan did not run; manually trigger if within 48h of a threshold crossing; document before clear. |
| `m35.org-lifecycle-handler` | 2 | 5 | Exponential, delay 5s, factor 2 | 1 per tenant | `m35.org-lifecycle-handler.dlq` | DLQ failure = a lifecycle event (org suspended/closed) was not forwarded to Stripe; manually pause/cancel via `/admin/subscriptions/:id/pause` or `/cancel`; document before clear. |

**BullMQ configuration sketch (shared across M35 queues):**

```typescript
// apps/backend/src/modules/35-subscription-billing/workers/queue-config.ts
export const M35_QUEUE_DEFAULTS = {
  defaultJobOptions: {
    removeOnComplete: { count: 1000, age: 7 * 24 * 3600 },  // keep 1 000 completed jobs for 7 days
    removeOnFail: false,                                       // failed jobs stay in queue until DLQ
  },
}

// Per-queue overrides (subset):
export const QUEUE_CONFIGS = {
  'm35.stripe-dispatcher': {
    priority: 1,
    attempts: 6,
    backoff: { type: 'exponential', delay: 2000 },
    concurrency: 5,
  },
  'm35.stripe-webhook-handler': {
    priority: 2,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    concurrency: 10,
  },
  // ... remaining queues per table above
} as const

// DLQ: BullMQ moves exhausted jobs to the failed set of the queue;
// a separate DLQ-drainer cron (per M1 platform-wide pattern) archives
// DLQ jobs to the `m35_dlq_archive` table for ops review.
// OPS-035: platform-ops must document before clearing.
```

### 4.10 M36 Typed Alert Payloads

```typescript
// packages/subscription-billing/src/alerts.ts
export const M35_ALERT_RULES = [
  {
    eventType: 'm35.subscription.created',
    severity: 'info',
    recipientResolver: 'role_set',
    recipientArgs: { roles: ['org_admin', 'billing_admin'] },
    systemLocked: false,
  },
  {
    eventType: 'm35.subscription.activated',
    severity: 'info',
    recipientResolver: 'role_set',
    recipientArgs: { roles: ['org_admin', 'billing_admin'] },
    systemLocked: false,
  },
  {
    eventType: 'm35.subscription.status_changed',
    severity: 'warn',
    recipientResolver: 'role_set',
    recipientArgs: { roles: ['org_admin', 'billing_admin'] },
    systemLocked: false,
  },
  {
    eventType: 'm35.invoice.payment_failed',
    severity: 'critical',
    recipientResolver: 'role_set',
    recipientArgs: { roles: ['org_admin', 'billing_admin'] },
    systemLocked: true,   // cannot be disabled — revenue-protection critical
  },
  {
    eventType: 'm35.dunning.entered_stage',
    severity: 'warn',
    recipientResolver: 'dunning_recipient_resolver',
    recipientArgs: {},
    systemLocked: true,   // cannot be disabled — revenue-protection critical
  },
  {
    eventType: 'm35.tenant.billing_blocked',
    severity: 'critical',
    recipientResolver: 'role_set',
    recipientArgs: { roles: ['org_admin', 'compliance_officer'] },
    systemLocked: true,
  },
  {
    eventType: 'm35.payment_method.expiring_soon',
    severity: 'warn',
    recipientResolver: 'role_set',
    recipientArgs: { roles: ['org_admin', 'billing_admin'] },
    systemLocked: false,
  },
  {
    eventType: 'm35.usage.overage_threshold_warning',
    severity: 'warn',
    recipientResolver: 'role_set',
    recipientArgs: { roles: ['billing_admin', 'accounts_receivable'] },
    systemLocked: false,
  },
  {
    eventType: 'm35.usage.overage_threshold_breached',
    severity: 'info',
    recipientResolver: 'role_set',
    recipientArgs: { roles: ['billing_admin', 'accounts_receivable'] },
    systemLocked: false,
  },
  {
    eventType: 'm35.refund.requested',
    severity: 'info',
    recipientResolver: 'platform_role_set',
    recipientArgs: { roles: ['platform_admin'] },
    systemLocked: false,
  },
  {
    eventType: 'm35.refund.failed',
    severity: 'critical',
    recipientResolver: 'platform_role_set',
    recipientArgs: { roles: ['platform_admin', 'platform_billing_admin'] },
    systemLocked: true,
  },
  {
    eventType: 'm35.stripe.api_call_failed',
    severity: 'warn',                                                                   // escalates to critical on 3rd consecutive failure
    recipientResolver: 'platform_role_set',
    recipientArgs: { roles: ['platform_billing_admin'] },
    systemLocked: false,
  },
]
```

M35 registers one new `RecipientResolver` (`dunning_recipient_resolver`) which resolves to org_admin + billing_admin + accounts_receivable, ordered by dunning stage (day_1 → silent in-app; day_7 → in-app + email; day_14 → in-app + email + SMS via M36; day_21 → all channels including phone if configured; day_28_suspend → critical channels only with platform-ops CC).

### 4.11 Outbox Event Catalog

All published via M1's outbox pattern in the same transaction as the state mutation. Subscribers may be M35-internal (the dispatcher and reconciler workers) or external (M33 reporting, M34 tenant console, M36 alerts).

| Event | Severity | Trigger | Payload (PHI-free; all ids are uuids or stripe ids) | Subscribers |
|---|---|---|---|---|
| `m35.subscription.created` | info | `subscription` insert | `{ subscriptionId, organizationId, planSlug, startedAt }` | M33, M34, M36 |
| `m35.subscription.activated` | info | status → active (from trialing) | `{ subscriptionId, organizationId, activatedAt }` | M33, M34, M36 |
| `m35.subscription.status_changed` | varies | every status transition | `{ subscriptionId, organizationId, fromStatus, toStatus, transitionedAt, reasonCode }` | M33, M34, M36 |
| `m35.subscription.plan_changed` | info | `plan_id` change | `{ subscriptionId, organizationId, fromPlanSlug, toPlanSlug, prorationBehavior, effectiveAt }` | M33, M34, M36 |
| `m35.subscription.canceled` | warn | status → canceled | `{ subscriptionId, organizationId, canceledAt, reasonCode, atPeriodEnd }` | M33, M34, M36 |
| `m35.subscription.paused` | warn | status → paused | `{ subscriptionId, organizationId, pausedAt, pausedUntil }` | M33, M34, M36 |
| `m35.subscription.resumed` | info | status away from paused | `{ subscriptionId, organizationId, resumedAt }` | M33, M34, M36 |
| `m35.subscription.suspended` | critical | status → suspended | `{ subscriptionId, organizationId, suspendedAt, reasonCode, lastSuccessfulPaymentAt }` | M33, M34, M36 |
| `m35.dunning.entered_stage` | warn | dunning_state transition | `{ subscriptionId, organizationId, fromStage, toStage, enteredAt, nextAttemptAt }` | M33, M36 |
| `m35.dunning.resolved` | info | dunning exit with `resolved` | `{ subscriptionId, organizationId, resolvedAt, lastStage }` | M33, M36 |
| `m35.invoice.created` | info | webhook `invoice.created` | `{ invoiceId, organizationId, stripeInvoiceId, totalCents, periodStart, periodEnd }` | M33, M36 |
| `m35.invoice.paid` | info | webhook `invoice.paid` | `{ invoiceId, organizationId, paidAt, amountPaidCents }` | M33, M36, M29 (Xero AR sync) |
| `m35.invoice.payment_failed` | critical | webhook `invoice.payment_failed` | `{ invoiceId, organizationId, failureCode, attemptCount, nextAttemptAt }` | M33, M36 |
| `m35.invoice.voided` | warn | webhook `invoice.voided` | `{ invoiceId, organizationId, voidedAt, voidedByMembershipId? }` | M33, M36 |
| `m35.invoice.uncollectible` | warn | webhook `invoice.marked_uncollectible` | `{ invoiceId, organizationId, markedAt }` | M33, M36 |
| `m35.payment_method.added` | info | `payment_method` insert | `{ paymentMethodId, organizationId, kind, isDefault }` | M33, M36 |
| `m35.payment_method.expiring_soon` | warn | expiry watcher | `{ paymentMethodId, organizationId, expiresAt, daysUntilExpiry }` | M33, M36 |
| `m35.payment_method.expired` | warn | `expires_at` < now | `{ paymentMethodId, organizationId, expiredAt }` | M33, M36 |
| `m35.payment_method.removed` | info | soft-delete | `{ paymentMethodId, organizationId, deactivatedAt }` | M33, M36 |
| `m35.usage.period_closed` | info | aggregator at period boundary | `{ subscriptionId, organizationId, periodStart, periodEnd, meterTotals }` | M33 |
| `m35.usage.overage_threshold_warning` | warn | aggregator crosses 80% | `{ subscriptionId, organizationId, eventType, totalQuantity, inclusiveQuantity, projectedOverageCents }` | M33, M36 |
| `m35.usage.overage_threshold_breached` | info | aggregator crosses 100% | `{ subscriptionId, organizationId, eventType, totalQuantity, inclusiveQuantity }` | M33, M36 |
| `m35.refund.requested` | info | `refund` insert | `{ refundId, organizationId, invoiceId, amountCents, requestedByMembershipId, reasonCode }` | M33, M36 |
| `m35.refund.approved` | info | `approved_at` set | `{ refundId, organizationId, approvedByMembershipId, approvedAt }` | M33, M36 |
| `m35.refund.executed` | info | `executed_at` set, success | `{ refundId, organizationId, executedAt, amountCents, stripeRefundId }` | M33, M36, M29 (Xero) |
| `m35.refund.failed` | critical | `status = executed_failed` | `{ refundId, organizationId, failedAt, stripeFailureCode }` | M33, M36 |
| `m35.promo.applied` | info | `promo_code_application` insert | `{ applicationId, organizationId, subscriptionId, promoCode, appliedByMembershipId }` | M33, M36 |
| `m35.promo.expired` | info | application end | `{ applicationId, organizationId, expiredAt }` | M33 |
| `m35.stripe.webhook_received` | info (internal) | webhook route | `{ stripeEventId, eventType, receivedAt, derivedOrganizationId }` | M35 internal (handler workers) |
| `m35.stripe.api_call_failed` | warn | non-2xx response | `{ apiCallAuditId, operation, organizationId?, attemptIndex, errorText }` | M33, M36 |
| `m35.tenant.billing_blocked` | critical | suspension at dunning day-28 | `{ organizationId, subscriptionId, blockedAt, dunningStage }` | M33, M34, M36 |
| `m35.revenue.monthly_snapshot_computed` | info | revenue cron | `{ snapshotId, snapshotMonth, mrrCents, arrCents, activeSubscriptions }` | M33 (platform-ops dashboard) |

### 4.12 Outbox Subscription Catalog

| Inbound topic | Source | M35 handler | Purpose |
|---|---|---|---|
| `m2.organization.activated` | M2 | `org-lifecycle-handler` | (optionally) create initial trial subscription on tenant go-live |
| `m2.organization.suspended` | M2 | `org-lifecycle-handler` | Pause Stripe subscription |
| `m2.organization.closed` | M2 | `org-lifecycle-handler` | Cancel Stripe subscription at period end |
| `m2.session.created` | M2 | `user-active-period-aggregator` | Update `user_active_period` (HMAC-pseudonymized) |
| `m5.patient.created` | M5 | `patient-active-period-aggregator` | Initialize patient pseudonym for the period |
| `m5.patient.status_changed` | M5 | `patient-active-period-aggregator` | Update `was_active` flag |
| `m5.patient.deceased` | M5 | `patient-active-period-aggregator` | Mark inactive with reason='died' |
| `m5.patient.merged` | M5 | `patient-active-period-aggregator` | Re-pseudonymize on merge target |

Each subscriber is idempotent on `(source_event_id)`; redeliveries are no-ops.

### 4.13 Stripe Dispatcher — The Outbox-Only API Path (D3)

Every outbound call to the Stripe API happens from the `stripe-dispatcher` BullMQ worker. The route handlers do not call Stripe directly — they emit an outbox event in the same transaction as the state mutation, and the dispatcher drains the outbox.

```typescript
// packages/subscription-billing/src/stripe/dispatcher.ts (sketch)
async function dispatch(event: M35StripeOutboxEvent): Promise<void> {
  const idempotencyKey = deriveIdempotencyKey(event)              // 'stripe-idem-{op}-{businessKey}-{attempt}'

  // Pre-check: have we already executed this idempotency key?
  const prior = await db.select().from(stripeApiCallAudit)
    .where(eq(stripeApiCallAudit.stripeIdempotencyKey, idempotencyKey))
    .limit(1)
  if (prior.length && prior[0].responseStatusCode && prior[0].responseStatusCode < 300) {
    return                                                         // already succeeded; no-op
  }

  const auditId = await db.insert(stripeApiCallAudit).values({
    stripeIdempotencyKey: idempotencyKey,
    operation: event.operation,
    targetResourceId: event.targetResourceId,
    organizationId: event.organizationId,
    requestEnvelopeRedacted: redactForAudit(event.payload),
    attemptIndex: event.attemptIndex ?? 0,
  }).returning({ id: stripeApiCallAudit.id })

  try {
    const start = Date.now()
    const response = await stripeClient[event.operation](
      event.payload,
      { idempotencyKey }
    )
    const latencyMs = Date.now() - start

    await db.update(stripeApiCallAudit)
      .set({
        responseStatusCode: response.statusCode,
        responseEnvelopeRedacted: redactForAudit(response.body),
        latencyMs,
      })
      .where(eq(stripeApiCallAudit.id, auditId[0].id))

    await applyStripeResponseToMirror(event, response)
  } catch (err) {
    await db.update(stripeApiCallAudit)
      .set({
        responseStatusCode: err.statusCode ?? 0,
        errorText: err.message,
        latencyMs: Date.now() - start,
      })
      .where(eq(stripeApiCallAudit.id, auditId[0].id))

    if (err.retryable && event.attemptIndex < 5) {
      throw err                                                    // BullMQ retries with exponential backoff
    }

    // Permanent failure → emit alert and DLQ
    await emitOutbox('m35.stripe.api_call_failed', { apiCallAuditId: auditId[0].id, ...event })
  }
}
```

### 4.14 Webhook Handler — HMAC-Verified, Dedup, Replay-Protected (D4 + D15)

```typescript
// apps/backend/src/modules/35-subscription-billing/routes/webhooks.stripe.ts (sketch)
import { stripeWebhookVerifier } from '../../../../../packages/subscription-billing/src/stripe/webhook-verifier'

export async function POST_stripe_webhook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sig = req.headers['stripe-signature']
  const raw = req.rawBody                                          // raw body required for HMAC

  let event: Stripe.Event
  try {
    event = stripeWebhookVerifier.verify(raw, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err) {
    // signature failure — do not log payload (may leak Stripe internals)
    return reply.code(401).send({ error: 'invalid signature' })
  }

  // Replay protection: reject events older than 30 days
  const ageDays = (Date.now() - event.created * 1000) / 86400000
  if (ageDays > 30) {
    return reply.code(410).send({ error: 'event too old' })
  }

  // Dedup: insert with ON CONFLICT DO NOTHING
  const inserted = await db.insert(stripeWebhookEvent).values({
    id: event.id,
    eventType: event.type,
    apiVersion: event.api_version,
    payloadCiphertext: envelopeEncrypt(JSON.stringify(event)),
    payloadDekRef: getCurrentDekRef(),
    receivedAt: new Date(),
    signatureVerifiedAt: new Date(),
    derivedOrganizationId: deriveOrgFromEvent(event),
  }).onConflictDoNothing().returning({ id: stripeWebhookEvent.id })

  if (inserted.length === 0) {
    // duplicate — already received; return 200 (Stripe TOS requires fast 200)
    return reply.code(200).send({ status: 'duplicate' })
  }

  // Emit internal outbox event — dispatched asynchronously by stripe-webhook-handler
  await emitOutbox('m35.stripe.webhook_received', { stripeEventId: event.id, eventType: event.type })

  return reply.code(200).send({ status: 'received' })
}
```

The handler worker (`stripe-webhook-handler`) drains `m35.stripe.webhook_received` events, decrypts the payload, and dispatches to per-event-type handlers (`handle_invoice_paid`, `handle_subscription_updated`, etc.). Each handler is idempotent on `(stripe_event_id, target_id)`.

### 4.15 Dunning State Machine (D7)

```
              ┌───────────┐
              │  current  │ ←── reset by manual admin action or successful payment
              └─────┬─────┘
                    │ payment_failed
                    ▼
              ┌───────────┐
              │   day_1   │ (silent in-app notice; first retry scheduled +24h)
              └─────┬─────┘
                    │ +6 days unresolved
                    ▼
              ┌───────────┐
              │   day_7   │ (in-app + email; second retry scheduled +7d)
              └─────┬─────┘
                    │ +7 days unresolved
                    ▼
              ┌───────────┐
              │  day_14   │ (in-app + email + SMS; third retry scheduled +7d)
              └─────┬─────┘
                    │ +7 days unresolved
                    ▼
              ┌───────────┐
              │  day_21   │ (final warning; all channels; fourth retry scheduled +7d)
              └─────┬─────┘
                    │ +7 days unresolved
                    ▼
              ┌─────────────────────┐
              │  day_28_suspend     │ (subscription → suspended; M35 emits
              │                     │  m35.tenant.billing_blocked)
              └─────┬───────────────┘
                    │ +32 days suspended
                    ▼
              ┌─────────────────────┐
              │  day_60_cancel      │ (subscription → canceled at Stripe;
              │                     │  M34 may revoke access)
              └─────────────────────┘
```

Any successful payment at any stage transitions to `resolved` and resets to `current`. Manual admin overrides (`/admin/dunning/:id/skip_stage`, `/admin/dunning/:id/reset`) record the override actor + audit-event linkage in the `dunning_state` row.

**Platform-floor cadences are platform-set.** Tenant overrides may *tighten* (suspend sooner) but never *loosen* (suspend later). The override is via `Organization.settings.m35_dunning_override_days` (capped server-side: `max(daysOverride, 28)` is rejected, only `min(daysOverride, 28)` is accepted as a tighter override).

### 4.16 — M35-F14: Valkey DB Numbering + Idempotency TTLs (SD-032, ARCH-263)

M35 respects the platform-wide Valkey database separation defined in SD-032:

| Valkey DB | Purpose | Who uses it |
|---|---|---|
| `db 0` | Cache + session storage **+ M1 idempotency middleware** | All modules via M1 primitives |
| `db 1` | BullMQ broker (all BullMQ queues platform-wide, including all M35 queues) | M1 BullMQ wrapper, all modules |
| `db 2` | Socket.IO adapter (pub/sub for M36 real-time alerts) | M36; M35 does not write to db 2 directly |

**M35-specific Valkey usage:**

- **M35 BullMQ queues** (`m35.stripe-dispatcher`, `m35.stripe-webhook-handler`, and all §4.9 queues) → **Valkey db 1** via the M1 BullMQ wrapper. M35 never connects to a Valkey instance or DB number outside this configuration; the connection string is inherited from the M1-provided BullMQ factory.
- **Inbound `Idempotency-Key` header storage** → **Valkey db 0**, TTL 24 hours, managed entirely by the M1 idempotency middleware (§4.17). M35 never writes to or reads from Valkey db 0 directly — it is handled transparently by the middleware.
- **M35 does not use Valkey for any PHI or pseudonym storage.** Valkey is ephemeral; PostgreSQL is the system of record for all M35 state (§14.4).
- **Outbound Stripe idempotency keys** are *not* stored in Valkey — they are derived deterministically from `(operation, businessKey, attempt_index)` and checked against `stripe_api_call_audit` in PostgreSQL (§4.13). This is distinct from the inbound `Idempotency-Key` header mechanism.

**TTL summary:**

| Key type | Valkey DB | TTL | Managed by |
|---|---|---|---|
| Inbound `Idempotency-Key` entries | db 0 | 24 h | M1 middleware |
| BullMQ job metadata (`m35.*` queues) | db 1 | Until processed + removed-on-complete policy (7 days / 1000 jobs) | BullMQ / M1 wrapper |
| Socket.IO rooms / events | db 2 | Session-scoped | M36 |

### 4.17 — M35-F08: Idempotency-Key on All Mutating Routes (ARCH-263, SD-053)

All M35 POST, PATCH, PUT, and DELETE routes accept an `Idempotency-Key` request header processed by the **M1 idempotency middleware**. The middleware behavior is:

- Stores `(org_id, Idempotency-Key, request_hash, response_status, response_body)` in Valkey db 0 with a **24-hour TTL**.
- On repeat: **same key + same body** → returns the cached response (idempotent replay).
- On repeat: **same key + different body** → returns **HTTP 409 Conflict** with body `{ "error": "idempotency_key_body_mismatch" }`.
- The header is optional; requests without it are processed normally (no caching). Routes that are natively idempotent (GET, the webhook POST) are exempt.

**M35 mutating routes that honor `Idempotency-Key`:**

| Method | Path | Typical `Idempotency-Key` pattern (client-chosen) |
|---|---|---|
| `POST` | `/v1/subscription` | `create-sub-{orgId}-{timestamp}` |
| `PATCH` | `/v1/subscription` | `plan-change-{subscriptionId}-{newPlanSlug}-{timestamp}` |
| `POST` | `/v1/subscription/cancel` | `cancel-{subscriptionId}-{timestamp}` |
| `POST` | `/v1/subscription/resume` | `resume-{subscriptionId}-{timestamp}` |
| `POST` | `/v1/payment_methods/setup_intent` | `setup-intent-{orgId}-{timestamp}` |
| `POST` | `/v1/payment_methods/attach` | `attach-pm-{orgId}-{stripePaymentMethodId}` |
| `PATCH` | `/v1/payment_methods/:id/set_default` | `set-default-pm-{paymentMethodId}-{timestamp}` |
| `DELETE` | `/v1/payment_methods/:id` | `detach-pm-{paymentMethodId}-{timestamp}` |
| `POST` | `/admin/plans` | `create-plan-{slug}-{timestamp}` |
| `PATCH` | `/admin/plans/:id` | `update-plan-{planId}-{timestamp}` |
| `POST` | `/admin/plans/:id/activate` | `activate-plan-{planId}` |
| `POST` | `/admin/plans/:id/deprecate` | `deprecate-plan-{planId}` |
| `POST` | `/admin/subscriptions/:id/pause` | `pause-sub-{subscriptionId}-{timestamp}` |
| `POST` | `/admin/subscriptions/:id/resume` | `resume-sub-{subscriptionId}-{timestamp}` |
| `POST` | `/admin/subscriptions/:id/cancel` | `cancel-sub-{subscriptionId}-{timestamp}` |
| `POST` | `/admin/subscriptions/:id/apply_promo` | `apply-promo-{subscriptionId}-{promoCode}` |
| `POST` | `/admin/dunning/:subscriptionId/skip_stage` | `skip-dunning-{subscriptionId}-{stage}-{timestamp}` |
| `POST` | `/admin/dunning/:subscriptionId/reset` | `reset-dunning-{subscriptionId}-{timestamp}` |
| `POST` | `/admin/refunds` | `request-refund-{invoiceId}-{amountCents}` |
| `POST` | `/admin/refunds/:id/approve` | `approve-refund-{refundId}-{approverMembershipId}` |
| `POST` | `/admin/refunds/:id/deny` | `deny-refund-{refundId}-{approverMembershipId}` |
| `POST` | `/admin/promos` | `create-promo-{stripeCouponId}` |
| `POST` | `/admin/webhooks/stripe/replay/:eventId` | `replay-webhook-{stripeEventId}` |

**Important distinction — inbound vs outbound idempotency:**

The `Idempotency-Key` header mechanism (M1 middleware, Valkey db 0, 24h TTL) is for **inbound requests from clients** to the M35 API — it prevents double-submission from retrying browsers or platform callers.

The **outbound Stripe idempotency key** (§4.13, `stripe_api_call_audit`) is a *separate, orthogonal mechanism* for M35's calls to the Stripe API. The outbound key is derived deterministically from `(operation, businessKey, attempt_index)` by `packages/subscription-billing/src/stripe/idempotency.ts` and is stored in PostgreSQL, not Valkey. These two mechanisms are independent: a client retrying a request with the same `Idempotency-Key` hits the M1 middleware cache before M35 code runs; if M35 code does run (e.g. no cached response), it emits an outbox event that the stripe-dispatcher will call Stripe with its own idempotency key.

-----

## 5. UI Surfaces

### 5.1 Web Application (Tenant-Facing, TanStack Router)

All M35 tenant screens live under `apps/frontend/src/modules/35-subscription-billing/` and are gated by route loaders that fetch typed DTOs (not raw Drizzle rows). The chrome banner ("Billing blocked — please update payment method") is mounted globally based on `GET /v1/billing/status` polled every 5 minutes.

| Route | Primary actor | Purpose |
|---|---|---|
| `/billing` | `org_admin`, `billing_admin` | Subscription overview: plan name, status, current period, next invoice estimate, dunning banner |
| `/billing/plan` | `org_admin` | Plan picker with comparison; current included quantities + overage rates per meter; "Change plan" CTA |
| `/billing/payment_methods` | `billing_admin` | List of stored payment methods; add card via Stripe Payment Element; set default; detach |
| `/billing/invoices` | `billing_admin`, `accounts_receivable` | Paged invoice list; filter by status (open/paid/void); link to Stripe-hosted page for each |
| `/billing/invoices/:id` | `billing_admin`, `accounts_receivable` | Invoice detail with line breakdown; "Download PDF" + "View on Stripe" CTAs |
| `/billing/usage` | `billing_admin`, `accounts_receivable` | Current-period meter usage with progress bars (% of included); historical chart |
| `/billing/dunning` | `org_admin`, `billing_admin` | Visible only when in dunning; shows stage, next retry date, "Update payment method" CTA |
| `/billing/promos` | `org_admin` | Apply a (publicly-visible) promo code; list of currently-applied promos |

### 5.2 Web Application (Platform-Ops Admin, `apps/admin/`)

The platform admin console under `apps/admin/src/modules/35-subscription-billing/`:

| Route | Primary actor | Purpose |
|---|---|---|
| `/admin/plans` | `platform_billing_admin`, `platform_admin` | List all plans with active/inactive/deprecated filter; CRUD modal |
| `/admin/plans/:id/edit` | `platform_admin` | Plan editor with meter management; "Sync to Stripe" CTA |
| `/admin/subscriptions` | `platform_billing_admin`, `platform_admin` | Cross-tenant subscription list with filters (status, plan, dunning stage, MRR contribution) |
| `/admin/subscriptions/:id` | `platform_billing_admin`, `platform_admin` | Detail view: state history, current dunning state, usage drill-down, refund history |
| `/admin/subscriptions/:id/pause` | `platform_billing_admin` | Pause modal with reason + until date |
| `/admin/subscriptions/:id/apply_promo` | `platform_billing_admin` | Apply a (admin-only) promo code |
| `/admin/refunds` | `platform_billing_admin`, `platform_admin` | Refund queue: requested awaiting approval, approved awaiting execution, executed, failed |
| `/admin/refunds/new` | `platform_billing_admin` | New refund request form with invoice picker + 40-char-min reason |
| `/admin/refunds/:id/approve` | `platform_admin` | Approval flow with step-up auth required + 4-eyes check |
| `/admin/dunning` | `platform_billing_admin`, `platform_admin` | List of subscriptions in dunning by stage; bulk actions disabled (one-at-a-time per-subscription overrides only) |
| `/admin/promos` | `platform_admin`, `platform_billing_admin` | Promo CRUD; redemption count visibility |
| `/admin/revenue` | `platform_owner`, `platform_admin`, `platform_billing_admin` | MRR/ARR dashboard: current month, trailing 12, breakdown by new/expansion/contraction/churn |
| `/admin/usage/:organizationId` | `platform_billing_admin`, `platform_support_t2` | Tenant usage drill-down: meter-by-meter, current period + historical |
| `/admin/webhooks/stripe` | `platform_billing_admin`, `platform_admin` | Recent webhook receipts: search by event id, status, age; "Replay" button (platform_admin only) |

### 5.3 Mobile App (Capacitor)

M35 has **no mobile surface in Phase 2.** Mobile clinicians do not interact with subscription billing. The mobile chrome may show a non-dismissible "Your account is suspended — contact your administrator" banner when `BillingStatusProvider.statusForOrg(orgId).isBlockedByBilling === true`, but there is no in-app remediation path on mobile (the org_admin must use the web app).

### 5.4 Patient/Family Portal

M35 has **no portal surface ever.** Patients and families never see subscription billing surfaces. The portal does not consume any M35 routes.

### 5.5 Accessibility (WCAG 2.1 AA)

- All M35 screens follow the WardenX standard WCAG 2.1 AA floor (consistent with M28, M33 admin surfaces).
- Stripe Elements is the only iframe-mounted component and meets WCAG 2.1 AA per Stripe's documented compliance.
- The dunning banner uses `role="alert"` with `aria-live="assertive"` for critical stages (day_28_suspend onward) and `aria-live="polite"` for lower stages.
- Currency amounts are announced with units ("twelve hundred fifty dollars") via `<abbr title="USD">$</abbr>` markup.
- The usage progress bars use both color (threshold-keyed) and a textual percentage announcement.
- Keyboard navigation through plan-picker, payment-method-list, invoice-list is fully accessible without a mouse.

-----

## 6. Permissions Matrix

> Enforcement is **Module 3's** RBAC/ABAC engine. This matrix specifies *intended* authorization so M3 can encode it.

### 6.1 Role Definitions (M35-Introduced and -Consumed)

| Role | Scope | Source |
|---|---|---|
| `org_admin` | per-Organization (tenant) | M2 (existing) |
| `billing_admin` | per-Organization (tenant) | M35 (new) |
| `accounts_receivable` | per-Organization (tenant) | M35 (new) |
| `compliance_officer` | per-Organization (tenant) | M2 (existing) |
| `platform_owner` | platform-wide | M2 / M34 (existing) |
| `platform_admin` | platform-wide | M2 / M34 (existing) |
| `platform_billing_admin` | platform-wide | M35 (new) |
| `platform_support_t2` | platform-wide | M34 (forward-defined; M2 has placeholder) |
| `platform_sales` | platform-wide | M34 (forward-defined; M2 has placeholder) |

### 6.2 Permission Matrix — Tenant Surface

| Permission | org_admin | billing_admin | accounts_receivable | other roles | ABAC predicate |
|---|---|---|---|---|---|
| `subscription.read` | ✅ | ✅ | ✅ | ❌ | `billing_scope_matches_org` |
| `subscription.create` | ✅ | ❌ | ❌ | ❌ | `billing_scope_matches_org` |
| `subscription.update` | ✅ | ❌ | ❌ | ❌ | `billing_scope_matches_org`, `plan_change_within_period_grace` (for `always_invoice`) |
| `subscription.cancel` | ✅ | ❌ | ❌ | ❌ | `billing_scope_matches_org` |
| `payment_method.read` | ✅ | ✅ | ✅ | ❌ | `billing_scope_matches_org` |
| `payment_method.write` | ✅ | ✅ | ❌ | ❌ | `billing_scope_matches_org` |
| `invoice.read` | ✅ | ✅ | ✅ | ❌ | `billing_scope_matches_org` |
| `usage.read` | ✅ | ✅ | ✅ | ❌ | `billing_scope_matches_org` |

### 6.3 Permission Matrix — Platform-Ops Surface

| Permission | platform_owner | platform_admin | platform_billing_admin | platform_support_t2 | platform_sales | ABAC predicate |
|---|---|---|---|---|---|---|
| `plan.admin.read` | ✅ | ✅ | ✅ | ❌ | ❌ | `platform_billing_scope` |
| `plan.admin.write` | ❌ | ✅ | ❌ | ❌ | ❌ | `platform_billing_scope` |
| `subscription.admin.read` | ✅ | ✅ | ✅ | ✅ | ❌ | `platform_billing_scope` |
| `subscription.admin.write` | ❌ | ✅ | ✅ | ❌ | ❌ | `platform_billing_scope` |
| `dunning.admin.override` | ❌ | ✅ | ❌ | ❌ | ❌ | `platform_billing_scope` |
| `refund.request` | ❌ | ✅ | ✅ | ❌ | ❌ | `platform_billing_scope` |
| `refund.approve` | ❌ | ✅ | ❌ | ❌ | ❌ | `platform_billing_scope`, `refund_requires_step_up_approval` |
| `refund.read` | ✅ | ✅ | ✅ | ❌ | ❌ | `platform_billing_scope` |
| `promo.admin.read` | ✅ | ✅ | ✅ | ❌ | ✅ | `platform_billing_scope` |
| `promo.admin.write` | ❌ | ✅ | ❌ | ❌ | ❌ | `platform_billing_scope` |
| `promo.admin.apply` | ❌ | ✅ | ✅ | ❌ | ❌ | `platform_billing_scope`, `promo_applicable_to_subscription` |
| `promo.admin.revoke` | ❌ | ✅ | ❌ | ❌ | ❌ | `platform_billing_scope` |
| `revenue.admin.read` | ✅ | ✅ | ✅ | ❌ | ❌ | `platform_billing_scope` |
| `revenue.admin.write` | ❌ | ✅ | ❌ | ❌ | ❌ | `platform_billing_scope` |
| `usage.admin.read` | ✅ | ✅ | ✅ | ✅ | ❌ | `platform_billing_scope` |
| `stripe.admin.read` | ❌ | ✅ | ✅ | ❌ | ❌ | `platform_billing_scope` |
| `stripe.admin.replay` | ❌ | ✅ | ❌ | ❌ | ❌ | `platform_billing_scope` |

### 6.4 ABAC Predicate-to-Permission Mapping (Test Anchor)

| Predicate | Permission(s) gated | Rationale |
|---|---|---|
| `billing_scope_matches_org` | every tenant-surface permission | tenant actors operate only on their own org |
| `platform_billing_scope` | every platform-surface permission | platform actors require PLATFORM tenant_scope |
| `refund_requires_step_up_approval` | `refund.approve` | 4-eyes + fresh step-up auth |
| `plan_change_within_period_grace` | `subscription.update` (only when `prorationBehavior='always_invoice'`) | surprises-the-customer protection outside 7-day grace |
| `promo_applicable_to_subscription` | `promo.admin.apply` | predicate-side validation mirrors Stripe-side |

### 6.5 Platform Floors

| Decision | Platform floor | Tenant override |
|---|---|---|
| Trial period (D12) | 14 days | tenant may set lower (e.g., 7); extending requires `platform_admin` |
| Dunning suspend stage (D7) | day 28 | tenant may set tighter (e.g., day 21); never looser |
| Dunning cancel stage (D7) | day 60 (post-suspend) | tenant may set tighter; never looser |
| Refund step-up freshness (D16) | 5 minutes | platform-only; not tenant-configurable |
| Webhook replay window (D4) | 30 days | platform-only |
| Invoice retention (D13) | 7 years | platform-only; not tenant-configurable |
| Currency (D9) | USD only Phase 1 | platform-only; multi-currency Phase 3 |

-----

## 7. Workflow Acceptance Criteria

Each workflow is the definitive contract for "what working looks like" on a code path; the integration test suite (§9.2) instantiates each as a Testcontainers scenario.

### W-SB-01 — Tenant Self-Service Subscription Creation

**Given** an Organization with `status='active'` and no existing subscription
**When** an `org_admin` calls `POST /v1/subscription` with `{planSlug: 'professional-monthly'}` and a valid `paymentMethodId`
**Then** in a single backend transaction:
1. A `subscription` row inserts with `status='trialing'`, `trial_ends_at = now + 14 days` (D12)
2. A `subscription_state_history` row records the transition from `null → trialing` with the actor membership id
3. An `m35.stripe.subscription.create_requested` outbox event emits with `idempotency_key = stripe-idem-customer-create-{orgId}-0`
4. A response 201 returns with the subscription DTO
5. The `stripe-dispatcher` worker drains the outbox event, creates the Stripe Customer (if not present), creates the Stripe Subscription, records the `stripe_customer_id` + `stripe_subscription_id` on the subscription row
6. A `m35.subscription.created` outbox event emits
7. An info-level alert to `org_admin` lands ("Welcome to WardenX; your 14-day trial begins now")

**Negative branches:**
- Plan slug not found → 404; no state change
- Organization already has an active subscription → 409; no state change
- `paymentMethodId` not attached to org → 400; no state change
- Stripe API failure mid-dispatch → audit row inserted; dispatcher retries with exponential backoff; subscription row remains in `trialing` until Stripe succeeds (and `stripe_subscription_id` is null in the interim)

### W-SB-02 — Trial-to-Active Conversion

**Given** a subscription in `trialing` with `trial_ends_at` 30 minutes in the past
**When** a Stripe webhook `customer.subscription.updated` arrives with `status='active'`
**Then**:
1. The webhook signature is verified; payload is envelope-encrypted into `stripe_webhook_event`
2. The `stripe-webhook-handler` worker drains the event
3. The subscription's `status` transitions `trialing → active`
4. `subscription_state_history` records the transition with `stripe_event_id` populated
5. `m35.subscription.activated` outbox event emits
6. An info-level alert to `org_admin` + `billing_admin` lands ("Your trial converted to a paid subscription")
7. The first paid `invoice` is created via webhook `m35.invoice.created` (separate webhook; correlated via `subscription_id`)

### W-SB-03 — Plan Change with Proration

**Given** a subscription in `active` on `starter-monthly`, current_period_start was 20 days ago
**When** an `org_admin` calls `PATCH /v1/subscription` with `{newPlanSlug: 'professional-monthly', prorationBehavior: 'create_prorations'}`
**Then**:
1. Predicate `plan_change_within_period_grace` evaluates → `true` (proration default is fine)
2. An outbox event `m35.stripe.subscription.update_requested` emits with the new `price_id` and proration directive
3. The dispatcher calls Stripe; Stripe issues a proration invoice line for the unused portion of starter + the new portion of professional
4. Webhook `customer.subscription.updated` arrives; subscription row updates `plan_id`; `subscription_state_history` records the change (note: this is not a status transition, but the history table accepts `from_status = to_status` with a `reason_code='plan_changed'`)
5. `m35.subscription.plan_changed` outbox event emits
6. An info-level alert to `org_admin` lands with old → new diff

**Negative branch:** if `prorationBehavior='always_invoice'` is requested and the current period is past day 7, only `platform_admin` can pass — tenant `org_admin` gets 403 from the predicate.

### W-SB-04 — Usage Event Ingest from M28 FHIR Egress

**Given** a tenant subscribed to `professional-monthly` with included `fhir_egress_request` = 10,000 / month
**When** M28's FHIR gateway records a successful read; M28 calls `UsageMeteringIngest.ingest({organizationId, eventType: 'fhir_egress_request', quantity: 1, sourceModule: 'm28', sourceEventId: 'fhir_search_audit_id_xyz'})`
**Then**:
1. The redactor validates the payload contains no PHI denylist fields → passes
2. `usage_event` row inserts with the source-event-id idempotency guarantee
3. `usage-aggregator` cron (hourly) rolls the event into `usage_period_aggregate` for the current Stripe billing period
4. If the new total crosses 80% of inclusive (8,000): `m35.usage.overage_threshold_warning` outbox event emits; alert to `billing_admin`
5. If the new total crosses 100% of inclusive (10,000): `m35.usage.overage_threshold_breached` outbox event emits; alert to `billing_admin` (info — overage is expected behavior)
6. `stripe-usage-posting` cron (daily) posts the aggregate to Stripe's `usage_record` API; records `stripe_usage_record_id`

**Negative branch:** repeated ingest with same `sourceEventId` is a no-op (`deduped: true` in response).

### W-SB-05 — Webhook Replay Protection

**Given** a Stripe webhook event with `created` timestamp 31 days in the past
**When** the webhook POSTs to `/v1/webhooks/stripe`
**Then**:
1. Signature verifies (Stripe's signing key still valid)
2. Replay protection check fails (ageDays > 30)
3. Response 410 Gone with body `{error: 'event too old'}`
4. No row inserted into `stripe_webhook_event`
5. No state change

### W-SB-06 — Dunning Day-1 Through Day-28-Suspend

**Given** a subscription in `active` whose invoice payment failed today (`m35.invoice.payment_failed` webhook just arrived)
**When** the `dunning-engine` cron runs daily at 09:00 tenant-tz
**Then over 28 days**:
- Day 1 → `dunning_state` row enters stage `day_1`; subscription status transitions `active → past_due`; silent in-app notice queued; first Stripe retry attempted +24h
- Day 7 → stage advances to `day_7`; in-app + email alert sent to `org_admin` + `billing_admin`
- Day 14 → stage advances to `day_14`; subscription status transitions `past_due → at_risk`; in-app + email + SMS via M36
- Day 21 → stage advances to `day_21`; all channels including phone if configured
- Day 28 → stage advances to `day_28_suspend`; subscription status transitions `at_risk → suspended`; `m35.tenant.billing_blocked` outbox emits; critical alert; M34 (when locked) consumes the event to gate feature access

**Negative branch:** any successful payment at any stage transitions to `resolved` (a `dunning_state` row with `exit_reason='resolved'`) and resets the subscription status to `active`.

### W-SB-07 — Refund Four-Stage Workflow with Step-Up

**Given** a paid `invoice` for $1,200; a `platform_billing_admin` Bob wants to refund $400; a `platform_admin` Alice will approve
**When**:
1. Bob calls `POST /admin/refunds` with `{invoiceId, amountCents: 40000, kind: 'partial', reasonCode: 'requested_by_customer', reasonDetail: 'Customer cancelled mid-period and we credited 1/3.'}`
2. `refund` row inserts with `status='requested'`; `m35.refund.requested` outbox emits; alert to `platform_admin`
3. Alice receives the alert, reviews; calls `POST /admin/refunds/:id/approve` with fresh step-up token
4. Predicate `refund_requires_step_up_approval` evaluates: step-up freshness ≤ 5min ✅; approver ≠ requester ✅; `roleKeys` includes `platform_admin` ✅ → allowed
5. `refund.status` transitions to `approved`; `approved_by_membership_id` set; `approver_step_up_audit_event_id` joins to M2's step-up audit row
6. `m35.refund.approved` outbox emits
7. `stripe-dispatcher` drains an `m35.stripe.refund.create_requested` event; calls Stripe; records `stripe_refund_id`; refund row transitions to `executed_success`
8. `m35.refund.executed` outbox emits; alert to `billing_admin` (the tenant's AR clerk sees the credit on Stripe)

**Negative branches:**
- Bob attempts to approve his own refund → predicate rejects (4-eyes)
- Alice's step-up token is 6 minutes old → predicate rejects
- Stripe refund call fails (e.g., disputed already) → refund row transitions to `executed_failed`; critical alert to `platform_admin`

### W-SB-08 — Patient Active Period Aggregation with HMAC Pseudonymization

**Given** an org with patient X (raw `patient_id = 'a1b2c3...'`) admitted in M5 last month
**When** M5 emits `m5.patient.created` outbox event with `{patientId: 'a1b2c3...', organizationId: 'orgY'}`
**Then**:
1. `patient-active-period-aggregator` worker drains the event
2. The pseudonymizer reads the active `patient_pseudonym_key` from `patient_pseudonym_key`
3. Computes `patient_pseudonym = HMAC-SHA256(key_material, 'a1b2c3...').hex()` → 32-hex string
4. Inserts a `patient_active_period` row with `patient_pseudonym`, `pseudonym_key_epoch`, `period_year_month` (current month), `was_active=true`, `became_active_at`
5. The raw `patient_id` does not enter `patient_active_period` (CHECK constraint on hex format would reject it anyway)
6. Reading `PatientCounterProvider.activePatientCountForPeriod` returns the count of distinct pseudonyms for the period

**Property test:** for any `patient_id` value, the same `patient_id` always produces the same pseudonym within a key epoch; different patient_ids produce different pseudonyms (no collisions with high probability).

### W-SB-09 — Pseudonym Key Rotation

**Given** the active `patient_pseudonym_key` is `epoch-2026-01`, in use since Jan 1
**When** a platform admin rotates the key on July 1 by inserting `epoch-2026-07` and setting it active
**Then**:
1. The new key is now active; new patient/user pseudonym ingests use `epoch-2026-07`
2. Historic `patient_active_period` rows with `pseudonym_key_epoch='epoch-2026-01'` are not re-pseudonymized (the same patient produces a different pseudonym under the new key — historical rows are simply tagged with their original epoch)
3. `PatientCounterProvider.activePatientCountForPeriod` for periods that span the rotation correctly counts distinct pseudonyms *within each epoch* (a patient active in both Jun and Jul shows up under two distinct pseudonyms, but for billing purposes the count is per-period, not cross-period, so the rotation is invisible to the meter math)
4. The old key is retired (`retired_at` set); it remains in the table for forensic re-pseudonymization if ever needed (defense-in-depth, controlled by `platform_admin`)

### W-SB-10 — Stripe Reconciliation Detects Drift

**Given** an `active` subscription with `stripe_subscription_id='sub_XYZ'`
**When** Stripe-side admin (out-of-band) changes the subscription to `paused` via the Stripe Dashboard (operator error)
**Then on the next hourly `subscription-reconciler` run**:
1. Reconciler calls Stripe API `subscriptions.retrieve(sub_XYZ)`; sees `status='paused'`
2. Reconciler detects drift: WardenX says `active`, Stripe says `paused`
3. **Stripe wins** (D2) — reconciler updates WardenX `subscription.status` to `paused`
4. `subscription_state_history` row records the transition with `reason_code='reconciler_drift_correction'` and `stripe_event_id` left null (no webhook triggered this)
5. `m35.subscription.paused` outbox emits
6. Alert to `platform_billing_admin` notes the drift correction so the operator can confirm intent
7. `m35.subscription.status_changed` to M34 (when locked) gates feature access

### W-SB-11 — Org Suspension by M2 Cascades to Stripe Pause

**Given** a tenant whose M2 `Organization.status='active'` and M35 `subscription.status='active'`
**When** a `platform_admin` suspends the org via M2 admin route (e.g., for compliance review); M2 emits `m2.organization.suspended`
**Then**:
1. M35's `org-lifecycle-handler` drains the event
2. Subscription status transitions `active → paused` with `reason_code='m2_organization_suspended'`
3. An outbox event `m35.stripe.subscription.pause_requested` emits
4. The dispatcher pauses the Stripe subscription (`pause_collection.behavior='void'`)
5. `m35.subscription.paused` emits to M33 / M34 / M36
6. Recovery: M2 un-suspending the org emits `m2.organization.activated` → M35 reverse path resumes the Stripe subscription

### W-SB-12 — AI Block Enforcement at Boot

**Given** an attempted boot where the M32 prompt registry contains a prompt with `domain='subscription_billing'`
**When** `validateM35AIBlock()` runs as a boot gate
**Then**:
1. The validator iterates M32's prompt registry
2. Detects the prohibited domain
3. **Boot refuses** with a clear error: `M35 AI block violation: M32 prompt 'invoice_dunning_polish' targets prohibited domain 'subscription_billing'. Remove the prompt or relocate it to a non-M35 domain.`
4. The application does not start

### W-SB-13 — Tenant Eraser Preserves Invoice Records

> **M35-F06 (ARCH-186/085/251):** The eraser uses a copy-then-delete transfer to
> `platform_retained_invoice` / `platform_retained_invoice_line`, not an in-place
> `organization_id` rewrite. See §3.7 for the full rationale and schema sketch.

**Given** a tenant in offboarding; org_admin requests data deletion per HIPAA Right of Erasure
**When** the M4 destruction workflow runs `M35DataEraser.eraseTenantData(orgId)`
**Then**:
1. Stripe subscription is canceled (best-effort)
2. **`invoice` + `invoice_line` rows are COPIED** into `platform_retained_invoice` /
   `platform_retained_invoice_line` (platform-retention tables with `original_organization_id`
   for forensic/regulatory traceability); the source rows are then deleted from the tenant-scoped
   `invoice` / `invoice_line` tables. No in-place org_id rewrite occurs.
3. All remaining tenant-scoped M35 rows are deleted in FK order: `refund`, `promo_code_application`,
   `user_active_period`, `patient_active_period`, `usage_period_aggregate`, `usage_event`
   (across all partitions), `payment_method`, `dunning_state`, `subscription_state_history`,
   `subscription`
4. The Stripe Customer at Stripe is tagged `metadata.wardenx_tenant_erased=true`
5. `EraseReceipt` returns with `platformRetentionTables: ['platform_retained_invoice', 'platform_retained_invoice_line']`
   and `transferredIds` containing the new platform-retention row ids; M4's destruction-certification
   and M34's offboarding orchestration both receive this receipt
6. After 7 years (per D13), a separate platform-retention cleanup job is eligible to delete the
   `platform_retained_*` rows if all applicable retention regulations have lapsed

### W-SB-14 — Payment Method Expiry Watch

**Given** a tenant with default payment method = card expiring 2026-11-30
**When** the `payment-method-expiry-watch` cron runs daily at 08:00 UTC
**Then at the 30/14/7/1-day thresholds**:
- 2026-10-31 (30 days): `m35.payment_method.expiring_soon` outbox emits with `daysUntilExpiry=30`; warn alert to `org_admin` + `billing_admin`
- 2026-11-16 (14 days): emits again with `daysUntilExpiry=14`; same alert path
- 2026-11-23 (7 days): emits again; alert escalates (in-app + email)
- 2026-11-29 (1 day): emits again; alert escalates (in-app + email + SMS)
- 2026-12-01 (expired): `m35.payment_method.expired` emits; `is_active=false`; if this was the default and no other active method exists, the next invoice will trigger dunning

### W-SB-15 — Cross-Tenant MRR Snapshot Does Not Leak Per-Tenant Data

**Given** the monthly `revenue-snapshot` cron runs on the 1st of the month at 00:30 UTC
**When** the snapshot computes
**Then**:
1. Reads `subscription` + `invoice` + `plan` across all tenants under `PLATFORM_RO` scope
2. Computes aggregate MRR / ARR / new / expansion / contraction / churn
3. Inserts a single row in `revenue_recognition_snapshot` with no tenant-level columns
4. `m35.revenue.monthly_snapshot_computed` outbox emits with platform-only-readable payload (no `organizationId` populated)
5. The M33 reporting dashboard at `/admin/revenue` reads the snapshot; the dashboard URL is gated by `revenue.admin.read`
6. The snapshot row is never exposed via any tenant-surface route (verified by route-permission test)

-----

## 8. Security, Privacy & Compliance

### 8.1 RLS Posture

Every tenant-scoped M35 table enforces RLS via the standard M1 pattern (§3.5). The platform-shared tables (`plan`, `plan_meter`, `promo_code`) have universal read + platform-only write. The Stripe audit tables (`stripe_webhook_event`, `stripe_api_call_audit`) are platform-only and not exposed to tenant queries. The `patient_pseudonym_key` table is platform-only with platform-admin-only access; reading it from a tenant route would be a serious privilege violation (it is the linkage that could theoretically enable re-identification, though the HMAC is one-way).

RLS isolation tests (§9.3) include:
- Two-tenant cross-leak: a `billing_admin` in org A receives 0 rows when querying `subscription` with org B's id forced via header injection
- `patient_pseudonym_key` is unreadable from any tenant session
- `stripe_webhook_event` is unreadable from any tenant session
- The `PLATFORM_RO` scope reads cross-tenant aggregates without modify capability; an attempt to UPDATE under `PLATFORM_RO` is refused at the policy

### 8.2 ABAC Enforcement

Five M35 predicates are registered with M3's named-predicate registry. Boot validator (`validatePredicates()` in M3) asserts every predicate referenced in M35's permission-to-predicate bindings is registered; a missing binding refuses startup.

Per-route ABAC enforcement happens at the route handler ingress: every M35 route's `preHandler` evaluates the route's permission key + ABAC predicate against the M3 engine, with the route handler receiving the evaluated decision (not the raw context).

The `refund_requires_step_up_approval` predicate is the highest-risk gate (controls actual money flow). Its predicate test suite has:
- ✅ Fresh step-up + 4-eyes → allow
- ❌ Stale step-up (>5min) → deny
- ❌ Same actor (requester==approver) → deny (4-eyes violation)
- ❌ No step-up token → deny
- ❌ Approver lacks `platform_admin` role → deny (only platform_admin approves)

### 8.3 STRIDE Threat Model

| Threat | Mitigation |
|---|---|
| **Spoofing** a tenant session to issue a refund | Refund routes require `platform_admin` role + step-up auth (M2 SESSION_POLICY billing-credential-admin profile). A leaked tenant session has no path to issue a refund — the routes are platform-ops only. |
| **Spoofing** Stripe webhook source | Every webhook POST is HMAC-verified via `STRIPE_WEBHOOK_SECRET`. Signature failure returns 401 with no payload logging. The secret is rotated annually per Ops Runbook §line-857. |
| **Tampering** with an invoice amount post-receipt | `invoice` is Stripe-authoritative (D2); the reconciler re-fetches Stripe-side on every webhook and on the hourly cron. A WardenX-side mutation that doesn't match Stripe gets corrected back to Stripe's view (Stripe wins). |
| **Tampering** with a usage event quantity to inflate an overage | `usage_event` is append-only; the source-event-id idempotency means a duplicate ingest is a no-op; the redactor rejects payloads with PHI denylist fields; the aggregator math is a pure-function rollup from `usage_event` rows. An attacker injecting a forged event would need direct DB write access (which RLS forecloses on tenant routes). |
| **Tampering** with a `subscription_state_history` row to fabricate a state transition | The table is append-only with M4 audit-trigger denial of UPDATE/DELETE. A forged INSERT would still be visible in the M4 audit trail and out-of-order timestamps would be detected by the reconciler. |
| **Tampering** with the HMAC pseudonym key to enable re-identification | `patient_pseudonym_key.key_material_ciphertext` is KMS-wrapped at rest; the wrap-key is platform-admin-managed and never exposed in code. The plaintext key bytes never persist outside the KMS-decryption call sites in the pseudonymizer. The Ops Runbook (§annual-key-rotation) covers rotation. |
| **Repudiation** of who approved a refund | The `refund.approved_by_membership_id` + `approver_step_up_audit_event_id` join into M2's step-up audit row + M4 audit-event linkage. The chain is end-to-end signed: requester's session → step-up biometric/passkey signature → approver's session → step-up biometric/passkey signature → refund row. A repudiated approval would have no signed audit chain. |
| **Repudiation** of who triggered a plan change | The PATCH route writes M4 audit on every state mutation; `subscription_state_history.actor_membership_id` is set; for Stripe-side changes, `stripe_event_id` is set. |
| **Information disclosure** via the invoice PDF URL | The `hosted_invoice_url` and `invoice_pdf_url` are denylisted from the M4 field-level audit capture (D3.6). The PDF stream endpoint validates `organization_id` matches the actor's scope before proxying from Stripe. A leaked PDF URL is single-tenant (the URL embeds a Stripe-side token that's scoped to that invoice). |
| **Information disclosure** via the MRR snapshot | The platform-shared `revenue_recognition_snapshot` table has no `organization_id`; the snapshot is purely cross-tenant aggregate. A tenant route querying it would fail the RLS policy (platform-only read). The M33 reporting dashboard at `/admin/revenue` is gated by `revenue.admin.read`. |
| **Information disclosure** of patient identity via M35 | Hard PHI boundary (D14). Per-patient meter uses HMAC pseudonyms (D6). A successful M35 database breach exposes pseudonyms + counts, never patient identity. The redactor enforces this at ingest time. |
| **Denial of service** via webhook flooding | Stripe-Signature HMAC verification happens before any DB write; signature-failure responses return immediately. Dedup table absorbs replayed events with no work. The rate limit on `/v1/webhooks/stripe` is platform-set (5,000 req/sec; Stripe's documented max delivery rate is far below this). |
| **Denial of service** via usage event flooding | `usage_event` is partitioned by month; high-volume insert scales linearly. The aggregator runs per-tenant under SKIP-LOCKED so one tenant's storm cannot block others. |
| **Elevation of privilege** by a tenant-side actor to access platform routes | The `platform_billing_scope` predicate checks `tenant_scope === 'PLATFORM'`. A tenant session never has PLATFORM scope. The dependency-cruiser rule (§13.2) also forbids tenant-route code paths from importing platform-route handlers. |

### 8.4 Audit & Compliance Log

M35 writes to M4 on every state-mutating route by calling `m4.audit(ctx)`. The M4 audit row captures:
- Actor membership_id, IP prefix, user-agent, M2 session class
- Route + permission key + ABAC predicate decisions
- Pre-mutation snapshot (for UPDATEs) — excluding any fields that M4's trigger-suppression policy has denylisted
- Post-mutation snapshot

Per M35-F05 (ADR-0144 / ARCH-281#5), M35 does NOT own the audit-trigger denylist. M35 registers
advisory posture hints for each owned table with M4's `AuditDenylistRegistry` at boot (§3.6).
M4 decides which high-volume tables (`usage_event`, `patient_active_period`, `user_active_period`,
`stripe_webhook_event`, `stripe_api_call_audit`) are trigger-excluded and which field-level
exclusions apply. M35's own append-only state-history tables provide the equivalent audit trail
for the excluded tables; this rationale is communicated to M4 as an advisory hint, not a unilateral decision.

`refund` is fully audited per state transition; the `approver_step_up_audit_event_id` joins M35's refund flow into M2's step-up audit row, producing a forensically reconstructable chain.

### 8.5 PHI-Minimization Rules

- Hard rule: no PHI in any M35 table, route, payload, log, alert, or outbound Stripe API call (D14)
- Pseudonymization at ingest time: M35's outbox-subscriber workers compute the HMAC pseudonym before persisting; the raw `patient_id` / `membership_id` lives only in the in-memory subscription handler call frame and is never logged
- Redactor (`packages/subscription-billing/src/stripe/redactor.ts`) enforces a denylist of PHI fields (`patient_id`, `mrn`, `name`, `dob`, `ssn`, `phone`, `email` (when associated with patient), `address`, `medication`, `diagnosis`, etc.) and refuses any usage-event ingest payload that contains them
- The redactor is unit-tested against a corpus of attempted-PHI payloads with the property that "the redactor rejects every payload that any known PHI-bearing seam could produce"
- Webhook payloads from Stripe are envelope-encrypted at rest (D15) on the assumption that Stripe could theoretically include sensitive fields in a future API version; the encryption is defense-in-depth

### 8.6 Retention & Erasure

| Class | Retention floor | Erasure behavior |
|---|---|---|
| `invoice`, `invoice_line` | 7 years (IRS §6001) | On tenant offboarding, rows are **copied** into `platform_retained_invoice` / `platform_retained_invoice_line` (platform-retention tables carrying `original_organization_id` for forensic traceability) then **deleted** from the tenant-scoped tables. No in-place `organization_id` rewrite. M4 destruction-certification receives the platform_retention_ids in the `EraseReceipt`. (M35-F06, ARCH-186/085/251) |
| `subscription`, `subscription_state_history`, `payment_method`, `dunning_state`, `refund`, `promo_code_application` | tenant-retention class | Deleted on tenant offboarding |
| `usage_event`, `usage_period_aggregate` | 24 months operational; archived to cold storage after | Deleted on tenant offboarding |
| `patient_active_period`, `user_active_period` | tenant-retention class | Deleted on tenant offboarding |
| `stripe_webhook_event`, `stripe_api_call_audit` | 7 years platform retention | Platform-retained beyond tenant offboarding; payload-decryption keys remain for forensic access |
| `plan`, `plan_meter`, `promo_code`, `revenue_recognition_snapshot`, `patient_pseudonym_key` | platform retention indefinite | Never erased on tenant offboarding |

### 8.7 Adapter Mandate (Stripe Client Isolation)

Stripe SDK access is restricted to `packages/subscription-billing/src/stripe/client.ts` via a dependency-cruiser rule:

```
{
  name: 'm35-stripe-sdk-adapter-only',
  severity: 'error',
  from: { pathNot: '^packages/subscription-billing/src/stripe/(client|webhook-verifier)\\.ts$' },
  to: { path: 'node_modules/stripe/' },
}
```

This forecloses on direct Stripe imports from anywhere else in the codebase; all access flows through the typed client wrapper that enforces idempotency, audit, and redaction.

### 8.8 AI Boundary (D8)

The M32 prompt registry has a per-domain whitelist enforcement. M35 declares its domain `subscription_billing` and asserts via a boot gate (`validateM35AIBlock()`) that:
1. No M32 prompt has `domain='subscription_billing'`
2. No M32 capability registers a handler that targets an M35-owned table or seam
3. No prompt template contains the strings `invoice`, `subscription`, `refund`, `dunning`, `mrr`, `arr` in a generative (non-read-only) context

Boot refuses if any of these conditions fail. A future M32 prompt that genuinely needs to *read* M35 data (e.g., "summarize this customer's billing history for support") would register under a `read_only=true` flag with explicit whitelist entry — but no M35 *generation* is permitted. The whitelist mirrors M22 D-pattern + M28 D14 + M12 D12 + M13 D15.

### 8.9 Secrets & External Services

| Secret | Stored | Rotation | Used by |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | App config (env var, KMS-decrypted at boot) | Annual (Ops Runbook §line-857) | `packages/subscription-billing/src/stripe/client.ts` |
| `STRIPE_WEBHOOK_SECRET` | App config | Annual + on incident | `packages/subscription-billing/src/stripe/webhook-verifier.ts` |
| `STRIPE_PUBLISHABLE_KEY` | Frontend env (public, by design) | Annual paired with secret key | Frontend Stripe Elements |
| `patient_pseudonym_key.key_material_ciphertext` | DB (KMS-wrapped at app layer) | Every 6 months | `packages/subscription-billing/src/pseudonym/hasher.ts` |
| `STRIPE_TEST_CLOCK_<test_id>` | CI only | Per CI run | CI integration tests |

The `STRIPE_SECRET_KEY` has restricted-key permissions per Stripe's restricted key feature: only the operations M35 actually needs (`customer.*`, `subscription.*`, `invoice.*`, `payment_method.*`, `refund.*`, `usage_record.*`, `coupon.*`, `promotion_code.*`, `meter.*`, `tax.*` for Stripe Tax). Other API operations (transfers, payouts to third parties, Connect operations) are denied by the key.

### 8.10 — M35-F09: 404/403 RLS Discipline + Error Envelope (SD-051, SEC-036)

#### Standard Error Envelope

All M35 routes return errors in the platform-standard error envelope (SD-051). No raw exception strings, no stack traces, no Drizzle/PostgreSQL error messages in production responses:

```typescript
// Shared from packages/core/src/error-envelope.ts
interface ErrorEnvelope {
  error: {
    code: string          // machine-readable: 'not_found', 'forbidden', 'conflict', 'validation_error', ...
    message: string       // human-readable; no PHI; no internal system names
    requestId: string     // correlation id for support triage
    details?: unknown     // optional structured detail (validation field errors, etc.)
  }
}
```

Example: a request for `/v1/invoices/some-other-org-invoice-id` by a tenant actor whose RLS policy returns 0 rows returns:

```json
{ "error": { "code": "not_found", "message": "Invoice not found.", "requestId": "req_..." } }
```

**Not:** `{ "error": "RLS policy violation: organization_id mismatch" }` — which would confirm cross-tenant existence.

#### 404-for-RLS-Hidden Rule

M35 adopts the platform 404-for-RLS-hidden rule (SEC-036): when a row exists but RLS denies visibility to the requesting actor, M35 routes return **HTTP 404**, not HTTP 403. This prevents IDOR enumeration — a tenant actor cannot distinguish "this invoice does not exist" from "this invoice exists but belongs to a different tenant."

The rule applies to all `:id` routes on tenant-scoped tables:

| Route | RLS-hidden response |
|---|---|
| `GET /v1/invoices/:id` | 404 |
| `GET /v1/invoices/:id/hosted_url` | 404 |
| `GET /v1/invoices/:id/pdf` | 404 |
| `PATCH /v1/payment_methods/:id/set_default` | 404 |
| `DELETE /v1/payment_methods/:id` | 404 |
| `GET /admin/subscriptions/:id` | 404 (platform actor: 403 if not `subscription.admin.read`) |
| `POST /admin/subscriptions/:id/pause` | 404 (platform actor: 403 if not `subscription.admin.write`) |
| `POST /admin/subscriptions/:id/resume` | 404 (platform actor: 403 if not `subscription.admin.write`) |
| `POST /admin/subscriptions/:id/cancel` | 404 (platform actor: 403 if not `subscription.admin.write`) |
| `POST /admin/refunds/:id/approve` | 404 |
| `POST /admin/refunds/:id/deny` | 404 |

Platform-ops routes (`/admin/`) where the actor is expected to have cross-tenant access: if the subscription or refund does not exist at all, return 404; if the actor lacks permission, return 403 with the standard error envelope. The distinction is: "resource does not exist" = 404; "resource exists but actor has no permission" = 403 (platform actors know the resource universe, tenants do not).

#### Object-Level IDOR Tests (Required)

The security test suite (§9.4) must include object-level IDOR tests for every `:id` route. Test pattern:

1. Create resource `R` belonging to org A.
2. Authenticate as a `billing_admin` in org B.
3. `GET /v1/invoices/{R.id}` → assert HTTP 404 (not 403, not 200 with R's data).
4. `PATCH /v1/payment_methods/{pm-of-org-A}/set_default` → assert HTTP 404.
5. Repeat for every `:id` route in §4.1 and §4.2 with a cross-tenant or cross-subscription resource id.

These tests are CI-gated and must remain green. A regression to 403 or 200 on a cross-tenant `:id` route is a P0 security finding.

-----

## 9. Testing & Observability

### 9.1 Unit Test Coverage

- Overall coverage target: ≥ 90%
- Strict targets ≥ 95% on:
  - `packages/subscription-billing/src/stripe/webhook-verifier.ts` (HMAC verification)
  - `packages/subscription-billing/src/stripe/redactor.ts` (PHI denylist)
  - `packages/subscription-billing/src/stripe/idempotency.ts` (idempotency key derivation)
  - `packages/subscription-billing/src/pseudonym/hasher.ts` (HMAC pseudonym)
  - `packages/subscription-billing/src/state-machine/subscription.ts` (XState v5 machine)
  - `packages/subscription-billing/src/state-machine/dunning.ts` (XState v5 machine)
  - `packages/subscription-billing/src/usage/aggregator.ts` (rollup math)
  - `packages/subscription-billing/src/revenue/snapshot.ts` (MRR math)

### 9.2 Integration Tests (Testcontainers)

15 named end-to-end scenarios mapping 1:1 to §7 workflows (W-SB-01 through W-SB-15). Each scenario instantiates:
- PostgreSQL with M35 migrations applied
- Valkey (BullMQ backend)
- MinIO (no M35 use, but the test substrate)
- A Stripe test-mode mock (using Stripe's test clock for time-dependent scenarios like trial conversion, dunning advancement)
- M1 + M2 + M3 + M4 + M5 + M28 + M29 + M36 + M38 minimal stubs (matched seams)

Stripe test clocks (Integrations §6.11) drive the trial-conversion scenario (W-SB-02) and the dunning multi-day advancement (W-SB-06) by simulating time advancement at the Stripe side.

### 9.3 RLS Isolation Tests

- Two-tenant cross-leak: org A's `billing_admin` queries the `subscription` table with an injected org B id; returns 0 rows; the same actor's query for its own org returns the right row
- `patient_pseudonym_key` is unreadable from any tenant session (even `org_admin`)
- `stripe_webhook_event` and `stripe_api_call_audit` are unreadable from any tenant session
- `revenue_recognition_snapshot` is unreadable from any tenant session; readable under `PLATFORM_RO`
- `plan` is universally readable; the `/v1/plans` route returns the same payload regardless of actor

### 9.4 Security Tests

- HMAC signature forgery: a webhook POST with an invalid Stripe-Signature header returns 401 with no DB write
- Webhook replay: a webhook with `created` timestamp 31 days in the past returns 410
- Webhook dedup: the same Stripe event id POSTed twice produces only one `stripe_webhook_event` row and one processing pass
- Idempotency-key forgery: a `POST /v1/subscription` retry uses the same idempotency-derived Stripe key; Stripe returns the cached response; no double-charge
- PHI denylist enforcement: `UsageMeteringIngest.ingest({...metadataRedacted: {patient_name: 'John Doe'}})` rejects with `accepted: false; reason: 'phi_denylist_violation'`
- Refund 4-eyes bypass attempt: a `platform_billing_admin` attempting `/admin/refunds/:id/approve` is denied even with a fresh step-up token (only `platform_admin` can approve)
- Cross-tenant pseudonym collision: a property test asserts that two distinct `patient_id` values within the same epoch never produce the same pseudonym (HMAC collision resistance)
- AI block: a synthetic M32 prompt with `domain='subscription_billing'` is rejected at boot

### 9.5 Frontend Tests (Playwright + Vitest + axe-core)

- Tenant subscription flow: load `/billing`, switch plan, verify the diff modal, confirm, verify state update
- Payment method flow: add a card via Stripe Elements (Stripe test mode), set default, detach
- Invoice flow: list, click into detail, click "View on Stripe" (assert redirect URL)
- Usage flow: assert progress bars, threshold colors, projected overage
- Dunning banner: simulate `BillingStatus.isBlockedByBilling=true`, assert banner visibility, click "Update payment method", verify navigation
- Admin refund flow: requester creates, approver receives alert, approves with step-up, verify state transitions
- axe-core: zero critical violations on every M35 screen
- Keyboard navigation: full plan-picker / payment-method-list / invoice-list flows without mouse

### 9.6 Performance Targets

- `GET /v1/subscription` p95 ≤ 100ms (read with `BillingStatusProvider` join + plan info; tenant-scoped)
- `GET /v1/billing/status` p95 ≤ 50ms (this is polled every 5 minutes by every frontend; must be fast)
- `GET /v1/invoices` p95 ≤ 200ms with up to 100 invoices in list
- `POST /v1/webhooks/stripe` p95 ≤ 100ms (signature verify + dedup write + outbox emit; processing is async)
- `UsageMeteringIngest.ingest` p95 ≤ 10ms (insert + idempotency check)
- `usage-aggregator` cron throughput ≥ 10,000 events/second per tenant
- `stripe-usage-posting` cron: all unposted aggregates for the prior period posted within 2 hours of period close
- `subscription-reconciler` cron: full sweep of all tenants completes within 5 minutes

### 9.7 Fixtures & Seed Data

Versioned fixtures live in `packages/subscription-billing/test/fixtures/`:
- `plans-v1.json` — three-tier catalog with realistic meter rates
- `stripe-webhook-corpus-v1.json` — sample webhook events for every type M35 handles
- `stripe-test-clock-scripts/` — Stripe test clock scripts for trial conversion, dunning advancement
- `usage-event-corpus-v1.json` — usage events with and without PHI denylist violations
- `pseudonym-key-rotation-v1.json` — key epoch rollover fixture

### 9.8 Observability

Every route emits a structured log + Prometheus metric. Key metrics:

| Metric | Type | Labels |
|---|---|---|
| `m35_route_request_total` | counter | `route`, `method`, `status_code` |
| `m35_route_latency_seconds` | histogram | `route`, `method` |
| `m35_stripe_webhook_received_total` | counter | `event_type`, `signature_status` |
| `m35_stripe_webhook_processed_total` | counter | `event_type`, `result` |
| `m35_stripe_webhook_processing_latency_seconds` | histogram | `event_type` |
| `m35_stripe_api_call_total` | counter | `operation`, `status_code` |
| `m35_stripe_api_call_latency_seconds` | histogram | `operation` |
| `m35_usage_event_ingested_total` | counter | `source_module`, `event_type`, `accepted` |
| `m35_usage_period_aggregate_posted_total` | counter | `event_type`, `result` |
| `m35_subscription_state_transitions_total` | counter | `from_status`, `to_status` |
| `m35_dunning_stage_total` | gauge | `stage` (count of subscriptions in each stage) |
| `m35_active_subscriptions_total` | gauge | `plan_tier` |
| `m35_mrr_cents` | gauge | (singleton — current month estimate) |
| `m35_refund_total` | counter | `kind`, `status` |
| `m35_payment_method_expiring_total` | gauge | `days_until_expiry_bucket` |

The M33 reporting dashboard surfaces these via the `RevenueMetricsProvider` seam.

### 9.9 Chaos & Failure Drills

- **Stripe API timeout:** drop Stripe network for 30 minutes; assert that the `stripe-dispatcher` retries with exponential backoff; assert that no duplicate Stripe Customers / Subscriptions are created on recovery (idempotency keys do their job)
- **Webhook delivery delay:** Stripe holds webhook delivery for 6 hours then bursts; assert dedup absorbs the burst and processing catches up within 15 minutes
- **Pseudonym key not retrievable** (KMS outage): assert that `patient-active-period-aggregator` enqueues retry instead of dropping events; the BullMQ DLQ tracks unrecoverable events for forensics
- **Reconciler drift:** force a divergence (insert a fake Stripe subscription); assert that the next reconciler pass detects and emits an alert; if drift is unresolvable in 3 attempts, the subscription is flagged for manual review

### 9.10 — M35-F17: Operational Alerts as OPS-043 YAML (OPS-043, SD-080)

M35 ships three infrastructure-level alert definitions as `alerts/*.yaml` files under `apps/backend/src/modules/35-subscription-billing/alerts/`. These complement the M36 typed alert rules (§4.10) which notify human users; these OPS-043 alerts notify the ops monitoring stack (Prometheus Alertmanager / PagerDuty / on-call rotation).

```yaml
# apps/backend/src/modules/35-subscription-billing/alerts/m35-webhook-backlog.yaml
# OPS-043 alert definition — webhook processing backlog
alert: M35WebhookBacklog
annotations:
  summary: "M35 Stripe webhook handler queue backlog is elevated"
  description: >
    The m35.stripe-webhook-handler BullMQ queue has more than {{ $value }} unprocessed
    jobs waiting for longer than 10 minutes. Stripe requires fast processing; backlog
    may cause webhook redelivery and duplicate events.
  runbook: "https://internal.wardenx.io/runbooks/m35/webhook-backlog"
expr: |
  bullmq_queue_waiting_jobs{queue="m35.stripe-webhook-handler"} > 50
    AND
  bullmq_queue_oldest_waiting_age_seconds{queue="m35.stripe-webhook-handler"} > 600
for: 5m
labels:
  severity: warning
  module: m35
  team: platform-ops
---
alert: M35WebhookBacklogCritical
annotations:
  summary: "M35 Stripe webhook handler queue critically backed up"
  description: >
    The m35.stripe-webhook-handler queue has {{ $value }} jobs waiting longer than
    30 minutes. Risk of webhook timeout and Stripe disabling the endpoint.
  runbook: "https://internal.wardenx.io/runbooks/m35/webhook-backlog"
expr: |
  bullmq_queue_waiting_jobs{queue="m35.stripe-webhook-handler"} > 200
    OR
  bullmq_queue_oldest_waiting_age_seconds{queue="m35.stripe-webhook-handler"} > 1800
for: 2m
labels:
  severity: critical
  module: m35
  team: platform-ops
```

```yaml
# apps/backend/src/modules/35-subscription-billing/alerts/m35-reconciler-drift.yaml
# OPS-043 alert definition — subscription reconciler drift
alert: M35ReconcilerDrift
annotations:
  summary: "M35 subscription reconciler has detected drift between WardenX and Stripe"
  description: >
    The m35.subscription-reconciler has corrected {{ $value }} subscriptions in the
    last hour where WardenX state differed from Stripe state. Occasional corrections
    are expected (e.g., Stripe Dashboard manual changes). A sustained rate indicates
    a systemic issue (missed webhook, dispatcher failure, or bug).
  runbook: "https://internal.wardenx.io/runbooks/m35/reconciler-drift"
expr: |
  increase(m35_subscription_reconciler_drift_corrections_total[1h]) > 3
for: 0m
labels:
  severity: warning
  module: m35
  team: platform-ops
---
alert: M35ReconcilerDriftCritical
annotations:
  summary: "M35 reconciler drift rate is critically high — possible data integrity issue"
  description: >
    More than 10 subscriptions required reconciler-driven state corrections in the
    last hour. Investigate dispatcher health and Stripe webhook delivery before
    the next billing cycle runs.
  runbook: "https://internal.wardenx.io/runbooks/m35/reconciler-drift"
expr: |
  increase(m35_subscription_reconciler_drift_corrections_total[1h]) > 10
for: 0m
labels:
  severity: critical
  module: m35
  team: platform-ops
```

```yaml
# apps/backend/src/modules/35-subscription-billing/alerts/m35-stripe-api-failure-rate.yaml
# OPS-043 alert definition — Stripe API failure rate
alert: M35StripeApiFailureRateElevated
annotations:
  summary: "M35 Stripe API call failure rate is elevated"
  description: >
    More than 5% of outbound Stripe API calls have failed (non-2xx) in the last
    5 minutes. Failures are retried with exponential backoff; sustained failures
    indicate Stripe API degradation or an M35 credential issue.
  runbook: "https://internal.wardenx.io/runbooks/m35/stripe-api-failures"
expr: |
  (
    rate(m35_stripe_api_call_total{status_code!~"2.."}[5m])
    /
    rate(m35_stripe_api_call_total[5m])
  ) > 0.05
for: 5m
labels:
  severity: warning
  module: m35
  team: platform-ops
---
alert: M35StripeApiFailureRateCritical
annotations:
  summary: "M35 Stripe API failure rate critical — billing operations impaired"
  description: >
    More than 25% of outbound Stripe API calls have failed in the last 5 minutes.
    Dispatcher is likely retrying; risk of BullMQ DLQ overflow. Check Stripe status
    page and STRIPE_SECRET_KEY validity. Revenue impact possible if invoices cannot
    be created or subscriptions cannot be updated.
  runbook: "https://internal.wardenx.io/runbooks/m35/stripe-api-failures"
expr: |
  (
    rate(m35_stripe_api_call_total{status_code!~"2.."}[5m])
    /
    rate(m35_stripe_api_call_total[5m])
  ) > 0.25
for: 2m
labels:
  severity: critical
  module: m35
  team: platform-ops
```

**Alert→runbook linkage:** each alert YAML references a runbook URL at `https://internal.wardenx.io/runbooks/m35/<topic>`. The runbook content lives in `apps/backend/src/modules/35-subscription-billing/runbooks/` and is included in the OPS Runbook composite during CI (T-43). The three runbook stubs required are: `webhook-backlog.md`, `reconciler-drift.md`, `stripe-api-failures.md`.

-----

## 10. Implementation Tasks

The build is organized into four phases. Each task is granular enough to map to a 1-3 day PR.

### Phase 1 — Substrate (T-01 to T-12)

- **T-01** Create `packages/subscription-billing` with the file structure per §3.1; wire Drizzle config + tsconfig + package.json
- **T-02** Define all enums (§3.3 `enums.ts`); migration `0035_subscription_billing.sql` ENUM phase
- **T-03** Define platform-shared tables (`plan`, `plan_meter`, `promo_code`, `revenue_recognition_snapshot`, `patient_pseudonym_key`) + their RLS policies; migration phase 2
- **T-04** Define tenant-scoped tables (subscription, invoice family, payment_method, usage family, dunning_state, refund, promo_code_application, patient/user_active_period); migration phase 3
- **T-05** Define platform-only Stripe audit tables (`stripe_webhook_event`, `stripe_api_call_audit`); migration phase 4
- **T-06** Apply indexes, partial-unique indexes, CHECK constraints, FKs; migration phase 5
- **T-07** Implement `packages/subscription-billing/src/stripe/client.ts` adapter with restricted-key wrapper
- **T-08** Implement `packages/subscription-billing/src/stripe/webhook-verifier.ts` with HMAC verification + ≥95% unit coverage
- **T-09** Implement `packages/subscription-billing/src/stripe/redactor.ts` PHI denylist enforcer + ≥95% unit coverage with adversarial corpus
- **T-10** Implement `packages/subscription-billing/src/stripe/idempotency.ts` deterministic key derivation + unit tests
- **T-11** Implement `packages/subscription-billing/src/pseudonym/hasher.ts` HMAC-SHA256 with key rotation + ≥95% coverage + collision property test
- **T-12** Implement `packages/subscription-billing/src/pseudonym/key-rotator.ts` + Ops Runbook procedure

### Phase 2 — Core Lifecycle (T-13 to T-24)

- **T-13** Implement XState v5 subscription state machine + ≥95% unit coverage of all transitions
- **T-14** Implement XState v5 dunning state machine + ≥95% unit coverage of cadences and overrides
- **T-15** Implement seam: `PlanCatalogReader` + `/v1/plans` public route
- **T-16** Implement seam: `SubscriptionStateProvider` + `BillingStatusProvider` + `/v1/subscription` GET / POST / PATCH routes
- **T-17** Implement payment method routes (`setup_intent`, `attach`, `set_default`, detach) + Stripe Elements integration on frontend
- **T-18** Implement webhook handler route + `stripe-webhook-handler` worker for the inbound event corpus
- **T-19** Implement `stripe-dispatcher` worker draining `m35.stripe.*` outbox events
- **T-20** Implement `subscription-reconciler` cron with drift detection + alert
- **T-21** Implement seam: `UsageMeteringIngest` + redactor wiring + ingest route (`POST /v1/usage` for internal-only ingest from M28/M29/M32)
- **T-22** Implement `usage-aggregator` cron + `stripe-usage-posting` cron + ≥95% unit coverage of rollup math
- **T-23** Implement `m5.patient.*` outbox subscriber + `patient-active-period-aggregator`
- **T-24** Implement `m2.session.created` + `m2.organization.*` outbox subscribers + handlers

### Phase 3 — Operator & Tenant Surfaces (T-25 to T-36)

- **T-25** Implement `dunning-engine` cron with platform-floor cadences + override routes
- **T-26** Implement refund 4-stage workflow routes + `refund_requires_step_up_approval` predicate
- **T-27** Implement promo code flow + `promo_applicable_to_subscription` predicate
- **T-28** Implement `revenue-snapshot` cron + `RevenueMetricsProvider` seam
- **T-29** Implement `payment-method-expiry-watch` cron + alerts
- **T-30** Frontend: tenant subscription / plan picker / payment methods / invoices / usage screens (apps/frontend)
- **T-31** Frontend: dunning banner + billing-blocked chrome
- **T-32** Frontend: admin plan editor + meter management (apps/admin)
- **T-33** Frontend: admin subscriptions / refunds / promos / revenue dashboards
- **T-34** Frontend: webhook log viewer + replay (admin)
- **T-35** All M36 alert rules registered; recipient resolvers (`dunning_recipient_resolver`) implemented
- **T-36** M4 audit denylist registrations; eraser registration

### Phase 4 — Hardening, Tests, Observability (T-37 to T-44)

- **T-37** Implement `validateM35AIBlock()` boot gate + register with M32's prompt registry
- **T-38** Forward-seam deny-stubs for `AITokenMeterProvider` (M32), `OnboardingStatusProvider` (M34)
- **T-39** Integration test suite (Testcontainers) for all 15 W-SB scenarios
- **T-40** RLS isolation tests + security test suite per §9.4
- **T-41** Performance tests for the targets in §9.6
- **T-42** Frontend tests (Playwright + axe-core) per §9.5
- **T-43** Observability instrumentation; M33 dashboard wiring; ops runbook entries for incident response (webhook backlog, reconciler drift, dunning stuck)
- **T-44** Chaos drills per §9.9; signoff against §12

-----

## 11. Resolved Decisions

| ID | Decision | Resolution | Rejected Alternatives | Rationale Anchor |
|----|----------|------------|-----------------------|---|
| **D1** | Plan model (ADR-001 closure) | **Hybrid per-seat + per-patient-month** with three tiers (Starter / Professional / Enterprise); each tier includes quantities of active patients + active users; overage meters on AI tokens, claim volume, FHIR egress, HL7 messages. Meter catalog platform-owned. | (i) Pure per-seat — under-charges large agencies with small clinical teams using software heavily. (ii) Pure per-patient-month — over-charges small agencies that try the platform. (iii) Tiered flat — leaves overage usage unmonetized, hides cost of scale. | §1.4 competitive context; ADR-001 |
| **D2** | Source-of-truth for subscription state | **Stripe is authoritative; WardenX is mirror.** On conflict, Stripe wins. Reconciler runs hourly + on every webhook. | (a) WardenX-authoritative — duplicates Stripe's state machine, creates drift. (b) Bi-directional source-of-truth — concurrency nightmare. | §2.1 cardinality; Integrations §6.11 |
| **D3** | Stripe API submission posture | **Outbox-only path** via `stripe-dispatcher` BullMQ worker. Deterministic Stripe idempotency keys from `(operation, businessKey, attempt_index)`. | (a) Direct API call from route handler — no retry/idempotency story; double-charge risk. (b) Sync-on-route with eventual catch-up — same problem with extra latency. | M23 D2 MAC submission pattern; M12 D3 DoseSpot |
| **D4** | Webhook ingestion posture | **Stripe-Signature HMAC verification at route boundary**; dedup via `stripe_webhook_event` (PK = Stripe event id) with `ON CONFLICT DO NOTHING`; 30-day replay window; payload envelope-encrypted (D15); processing async via `stripe-webhook-handler` worker. | (a) Sync processing in route handler — Stripe TOS requires fast 200; sync processing can't meet SLA reliably. (b) Skip signature verification (dev-only) — Stripe TOS violation; grounds for integration suspension. | Stripe TOS; Integrations §7.5 inbound webhooks |
| **D5** | Usage metering architecture | **Append-only `usage_event` partitioned by month** → per-period `usage_period_aggregate` → Stripe `usage_record`. Three-level idempotency. | (a) Direct Stripe usage_record posting from source modules — Stripe rate-limited; lossy on partial failures. (b) Single aggregate-only table with UPSERT — lossy on adversarial double-count; harder to audit. | M29 §2.6 idempotency pattern |
| **D6** | Per-patient / per-user identifiers in M35 | **HMAC-SHA256 pseudonym with platform-side rotating key** (`patient_pseudonym_key`). Raw `patient_id` / `membership_id` never enters M35 tables, audit logs, or Stripe payloads. | (a) Use raw `patient_id` — even though commercial billing has no PHI requirement, a successful Stripe breach would expose patient-identity-correlatable counters; defense-in-depth says no. (b) Use a salt prefix (deterministic but reversible) — provides no protection in the breach case. | §1.2 PHI boundary; §8.3 STRIDE worst-case |
| **D7** | Dunning lifecycle | **XState v5 finite machine** `current → past_due → at_risk → suspended → canceled` with platform-floor cadences day 1 / 7 / 14 / 21 / 28 (suspend) / 60 (cancel). Tenants may tighten, never loosen. | (a) Tenant-fully-configurable — defeats revenue-protection floor; some tenants would set "never suspend" defeating the model. (b) Stripe's built-in Smart Retries only — lacks the in-app communication ladder + role-based recipient routing. | Platform-floor / tenant-tighten-only architecture rule (§memory) |
| **D8** | AI-prohibited zone for M35 | **M32 may not synthesize, modify, or redact** subscriptions, invoices, dunning copy, refund decisions, or plan changes. Boot-gated via `validateM35AIBlock()`. | (a) Allow LLM-polished dunning emails — the polish risks tone-misalignment in a high-stakes revenue-protection context; risk-reward is wrong. (b) Allow LLM refund-decision-assist — risk of LLM rationalizing inappropriate refunds; high financial impact. | M12 D12 / M13 D15 / M22 D-pattern / M28 D14 mirror |
| **D9** | Currency | **USD-only Phase 1**; ISO 4217 validated via M38; multi-currency Phase 3. | (a) Multi-currency Phase 2 — Stripe Tax US is well-supported; international tax is materially more complex; defer until international tenants exist. | Phase 3 scope per architecture §20.A |
| **D10** | Tax computation | **Stripe Tax as sole engine.** WardenX never computes tax. Invoice tax lines mirror Stripe Tax. | (a) Build a tax engine — months of compliance work for no differentiation. (b) Manual tax entry per tenant — operational nightmare. | Integrations §6.11 |
| **D11** | Plan catalog ownership | **Platform-owned; no tenant overlay.** Every meter maps to a Stripe `meter` resource. | (a) Tenant-overlayable plans — explodes the cross-product of Stripe pricing models; operational complexity. (b) Hybrid (platform + tenant) — same issue at lower scale. | M23 D-platform-floor pattern; M26 cap-period-platform-constant |
| **D12** | Trial period | **14-day platform floor.** Tenant may tighten (shorter trial); extending requires `platform_admin` role with audited reason. | (a) Tenant-fully-configurable — tenants set 365-day trials and never convert. (b) No trial — anti-competitive in B2B SaaS. | Platform-floor / tenant-tighten-only rule |
| **D13** | Invoice retention | **7-year platform retention floor** (IRS §6001). On tenant offboarding, `invoice` + `invoice_line` rows are **copied** into first-class platform-retention tables (`platform_retained_invoice`, `platform_retained_invoice_line`) that carry `original_organization_id` for forensic/regulatory traceability, then deleted from the tenant-scoped tables. No in-place `organization_id` rewrite. Other M35 tenant data is destroyed per the standard eraser path. (M35-F06, ARCH-186/085/251.) | (a) Delete invoices on offboarding — IRS §6001 violation risk. (b) Indefinite retention — privacy creep; the 7-year floor matches the longest non-fraud IRS lookback. (c) In-place org_id rewrite (prior design) — corrupts the FK value that RLS and downstream readers depend on; replaced by the copy-then-delete transfer. | IRS §6001; Treasury Reg §6001 |
| **D14** | PHI boundary | **Hard NO. No PHI in any M35 row, route, payload, log, alert, or outbound Stripe API call.** Pseudonymization at ingest (D6); redactor enforces denylist; STRIDE worst-case is commercial-billing-counts disclosure. | (a) Best-effort minimization — porous; we'd find PHI in the system within 6 months. (b) "PHI allowed but audited" — opens BAA exposure on the Stripe vendor surface (currently not BAA-bearing per Integrations §6.11). | §8.5 PHI-Minimization; Integrations §6.11 no-BAA posture |
| **D15** | Webhook payload encryption at rest | **Envelope-encrypted via the standard WardenX KMS-wrapped DEK pattern.** Stripe payloads carry commercial-sensitive data (amounts, customer ids) but no PHI by contract — encryption is defense-in-depth. | (a) Plaintext at rest — Stripe data is sensitive even without PHI; ops staff with DB read could see customer-level financials. (b) Encrypt only the body field — partial measure; metadata is also sensitive. | M29 §3 PHI ciphertext pattern (applied non-PHI here) |
| **D16** | Refund workflow | **Four-stage:** requested (`platform_billing_admin`) → approved (`platform_admin` only; step-up + 4-eyes) → executed (outbox dispatcher; Stripe-side) → success or failed. Reason ≥40 chars. | (a) One-step refund — no oversight on money flow. (b) Two-step (request + execute) — no 4-eyes check; insider risk. | M2 SESSION_POLICY billing-credential-admin step-up + M23 D-override-pattern |
| **D17** | Promo code apply path | **Platform-ops-only.** Tenants cannot self-apply (except for the optional public-facing promo code field on the subscribe form, which is whitelisted). All applications recorded in `promo_code_application` with M4 audit linkage. | (a) Tenant self-serve promo apply — fraud / abuse via leaked codes. (b) Platform-only without exception — kills the marketing-promo use case. | M23 D-override-pattern |
| **D18** | MRR/ARR computation cadence | **Monthly snapshot on the 1st at 00:30 UTC**; computed by the `revenue-snapshot` cron. Standard SaaS MRR definition. Stored in platform-shared `revenue_recognition_snapshot`. On-demand recompute via `/admin/revenue/snapshots/compute`. | (a) Real-time MRR (every-event computed) — heavy query load for marginal value; monthly snapshot is the operating cadence anyway. (b) Quarterly only — too infrequent for operational decisions. | Standard SaaS practice |
| **D19** | Tenant lifecycle integration | **M2's `Organization.status` is the trigger; M35 reactively pauses/cancels via outbox subscribers** (`m2.organization.suspended` → pause Stripe; `m2.organization.closed` → cancel at period end). Conversely, M35 emits `m35.tenant.billing_blocked` when it self-suspends at dunning day-28; M34 (when locked) consumes this to gate features. | (a) M35 owns suspension authority — splits responsibility; M2 should own org lifecycle. (b) M2 directly calls Stripe API — couples M2 to Stripe; violates module isolation. | Outbox-only cross-module communication |
| **D20** | Published seams | **Six seams** (`SubscriptionStateProvider`, `BillingStatusProvider`, `UsageMeteringIngest`, `PatientCounterProvider`, `RevenueMetricsProvider`, `PlanCatalogReader`) registered into M1's typed `SeamRegistry`. Boot refuses on missing registration. | (a) Three seams (collapse the read-paths) — kills clean separation of concerns. (b) Twelve seams (one per route) — over-decomposition; brittle interfaces. | M28 D17 / M29 D-pattern |
| **D21** | Outbox subscription catalog | **8 inbound subscriptions:** `m2.organization.{activated,suspended,closed}`, `m2.session.created`, `m5.patient.{created,status_changed,deceased,merged}`. Each handler idempotent on `source_event_id`. | Skipping `m5.patient.merged` — leaves pseudonym aggregates wrong post-merge. Skipping `m2.session.created` — kills per-user metering. | §4.12 |
| **D22** | STRIDE coverage | **Per §8.3 table** — 16 named threats mapped to specific mitigations. The HMAC pseudonym (D6) makes the worst-case breach scenario commercial-only, not PHI. | A weaker threat model that ignores tampering-at-rest or insider-approver — opens audit gaps. | §8.3 |
| **D23** | Manifest patch | **`M35.dependsOn = [1, 2, 3, 4, 5, 28, 29, 32, 36, 38]`** (the architecture's `[34]` was build-sequence shorthand, not a code dependency); `M35.codePaths = ['packages/subscription-billing', 'apps/backend/src/modules/35-subscription-billing']`; `M35.ownedTables` populated with 19 tables (12 tenant-scoped + 5 platform-shared + 2 platform-only Stripe audit); 5 ABAC predicates registered into M3; 6 seams published. (ratified by ADR-0025 — M35.dependsOn drops 34; seam both ways.) | Keeping `dependsOn=[34]` — omits the actual import surface (M2 OrganizationReader, M5 outbox subscriptions, M36 alerts, M38 currency, M4 audit, etc.). | §13.1 |
| **D24** | Direction of M34↔M35 dependency | **M34 depends on M35** (M34 consumes M35's `SubscriptionStateProvider` + `BillingStatusProvider` for its tenant admin console). **M35 does NOT depend on M34.** M35 reads M2's `Organization.status` directly and consumes `OnboardingStatusProvider` from M34 as a forward-seam deny-stub (real wiring when M34 locks). (ratified by ADR-0025 — M35.dependsOn drops 34; seam both ways.) | Reverse direction per architecture §20 sketch — that direction couples M35 to a not-yet-existing M34 and inverts the actual seam ownership (M35 is upstream of M34 in the read-direction graph). | §1.2 boundaries; manifest dependency-direction discipline (memory) |

-----

## 12. Acceptance Sign-Off Checklist

Before promoting M35 from "spec locked" to "implementation in progress" → "in production," every item below must be checked.

### 12.1 Decisions & Architecture
- [ ] All 24 decisions D1–D24 recorded in §11 with chosen approach + rejected alternatives
- [ ] Manifest patch (§13) applied to `module-manifest.ts`; reviewed against actual `dependsOn` direction (no inverted edges)
- [ ] Dependency-cruiser config merged; CI enforces M35 boundaries including the Stripe-SDK adapter mandate (§8.7)
- [ ] Table-ownership lint registers all 21 owned tables (12 tenant + 5 platform-shared + 2 platform-only Stripe audit + 2 platform-retention per M35-F06)
- [ ] Five new ABAC predicates landed in M3 registry; boot validator passes
- [ ] Six published seams declared in M35's `publishedSeams`; eight inbound outbox subscriptions declared
- [ ] Forward-seam deny-stubs land for M32 `AITokenMeterProvider` and M34 `OnboardingStatusProvider`

### 12.2 Schema & Data
- [ ] Drizzle schema files exist for all 19 tables; types match §3.3
- [ ] Migrations apply forward and reverse clean against a fresh DB
- [ ] RLS policies on tenant tables enforce `organization_id = current_setting(...)`
- [ ] RLS policies on platform-shared tables enforce platform-scope write
- [ ] `patient_pseudonym_key` is platform-only read+write; never readable from tenant sessions
- [ ] `usage_event` partitioning by month works; first six partitions pre-created
- [ ] Indexes per §3.4 present and used by `EXPLAIN` on canonical queries
- [ ] Audit denylist registers all M35 tables per §3.6 with the right posture
- [ ] `M35DataEraser` registered; eraser test confirms `invoice` + `invoice_line` rows are COPIED to `platform_retained_invoice` / `platform_retained_invoice_line` then deleted from tenant-scoped tables (M35-F06 — no in-place org_id rewrite)
- [ ] `platform_retained_invoice` and `platform_retained_invoice_line` added to `M35.ownedTables` in `architecture/module-manifest.ts` (M35-F06 manifest impact — 19 → 21 tables)

### 12.3 Routes & Seams
- [ ] All routes from §4.1 / §4.2 / §4.3 implemented; TypeBox schemas enforced
- [ ] Permission keys from §4.7 wired to each route; ABAC predicates per §6 mapping
- [ ] All six published seams have implementations registered in `SeamRegistry` at boot
- [ ] Consumed seams verified present at boot (`OrganizationReader`, `MembershipReader`, `AlertEmitter`, `TerminologyProvider`); missing seams fail boot
- [ ] Forward-seam deny-stubs for M32 / M34 throw `NotImplementedError` on call (until real impls land)
- [ ] Outbox event catalog (§4.11) emitted at the right side-effect points
- [ ] BullMQ queues (§4.9) registered and draining

### 12.4 Workflow Acceptance
- [ ] W-SB-01 through W-SB-15 integration tests pass against a Testcontainers stack with Stripe test mode + test clocks
- [ ] E2E Playwright suites pass for all tenant + admin screens
- [ ] Manual operator-acceptance walk-through (per the Ops Runbook) signed off by the platform-ops rotation lead

### 12.5 Security
- [ ] Stripe-Signature HMAC verification refuses invalid signatures
- [ ] Webhook replay protection (30 days) returns 410
- [ ] Webhook dedup absorbs replays (single processing pass)
- [ ] Stripe idempotency keys prevent double-create / double-charge
- [ ] PHI denylist enforcement rejects any usage event containing denylisted fields
- [ ] Refund 4-eyes + step-up gate refuses same-actor approval and stale-token approval
- [ ] AI block (`validateM35AIBlock()`) refuses boot if M32 has any prohibited prompts
- [ ] Pseudonym collision property test passes (no collisions across 10M synthetic patient_ids)
- [ ] Two-tenant RLS cross-leak test green
- [ ] STRIDE table (§8.3) — every threat has an automated test or a documented manual-test in the security suite

### 12.6 Frontend
- [ ] All 8 tenant screens per §5.1 implemented and routed
- [ ] All 15 admin screens per §5.2 implemented and routed
- [ ] No mobile (per §5.3) and no portal (per §5.4) — confirmed by route map
- [ ] WCAG 2.1 AA audited green on every M35 screen via axe-core CI
- [ ] Stripe Elements integration tested in Stripe test mode end-to-end

### 12.7 Tests
- [ ] Unit tests ≥ 90% overall, ≥ 95% on the 8 named hot files (§9.1)
- [ ] Integration tests (§9.2) cover the 15 W-SB scenarios end-to-end
- [ ] RLS isolation tests (§9.3) green
- [ ] Security tests (§9.4) green
- [ ] Performance targets (§9.6) met on the load-test rig
- [ ] Frontend tests (§9.5) green
- [ ] Fixtures (§9.7) versioned and CI-checked
- [ ] Chaos drills (§9.9) — Stripe API timeout / webhook flood / pseudonym key outage / reconciler drift all green

### 12.8 Observability
- [ ] Every route emits a structured log + a Prometheus metric per §9.8
- [ ] M33 dashboard tiles consume `RevenueMetricsProvider`
- [ ] Webhook latency + processing backlog visible on ops dashboard
- [ ] Stripe API failure rate visible on ops dashboard; alerts wired
- [ ] Dunning stage gauge visible on platform-ops dashboard

### 12.9 Consumers (Forward Seams)
- [ ] **(forward seam)** M34 SaaS console consumes `SubscriptionStateProvider` + `BillingStatusProvider` when M34 locks
- [ ] **(forward seam)** M33 reporting consumes `RevenueMetricsProvider` for the platform-ops revenue dashboard when M33 implementation Phase 2 lands
- [ ] **(forward seam)** M28 FHIR Gateway calls `BillingStatusProvider.isQuotaAvailable` for egress quotas when Phase 2 quotas activate
- [ ] **(forward seam)** M29 External Interfaces calls `BillingStatusProvider.isQuotaAvailable` for HL7 message quotas when Phase 2 quotas activate
- [ ] **(forward seam)** M32 AI Platform calls `UsageMeteringIngest.ingest` for AI token usage when M32 locks

### 12.10 Manifest
- [ ] Apply the §13 manifest patch
- [ ] `bun run arch:fitness` green (dependency-cruiser boundary check + `check-table-ownership.ts`)
- [ ] `validateSeams()` boot gate green
- [ ] `validateM35AIBlock()` boot gate green (no prohibited prompts in M32's registry)

-----

## 13. Proposed Manifest Patch (D23)

```diff
--- a/packages/shared/src/module-manifest.ts
+++ b/packages/shared/src/module-manifest.ts
@@ -??,7 +??,7 @@ export const MODULES: ModuleDef[] = [
   { id: 35, name: "Subscription Billing",
-    codePaths: [], dependsOn: [34], ownedTables: [] },
+    codePaths: [
+      "packages/subscription-billing",
+      "apps/backend/src/modules/35-subscription-billing"
+    ],
+    dependsOn: [], // ADR-0025: M34<->M35 seam-based, no edge; minimal set per ADR-0005 D5 pass.
+    ownedTables: [
+      "plan",
+      "plan_meter",
+      "patient_pseudonym_key",
+      "subscription",
+      "subscription_state_history",
+      "payment_method",
+      "invoice",
+      "invoice_line",
+      "usage_event",
+      "usage_period_aggregate",
+      "patient_active_period",
+      "user_active_period",
+      "stripe_webhook_event",
+      "stripe_api_call_audit",
+      "dunning_state",
+      "revenue_recognition_snapshot",
+      "promo_code",
+      "promo_code_application",
+      "refund",
+      // M35-F06 (ARCH-186/085/251): two platform-retention tables added (19 → 21 total).
+      // These replace the unsafe in-place organization_id rewrite in the prior eraser design.
+      "platform_retained_invoice",
+      "platform_retained_invoice_line"
+    ],
+    // Non-ModuleDef fields (seams/registrations/phase/tier/status/metadata) removed per ARCH-146/ADR-0005 — wired at boot, not in the manifest.
+  },
```

### Dependency Direction Justification

| Dependency | Read Direction | Justification |
|---|---|---|
| M1 (Foundation) | M35 reads from M1 | Outbox helpers, BullMQ wrapper, Fastify shell, idempotency-key primitives, KMS envelope-encryption helpers (for D15 webhook payload, pseudonym key wrapping) |
| M2 (Identity & Org) | M35 reads from M2 | `OrganizationReader` for tenant identity; `MembershipReader` for user-count metering; `m2.organization.*` and `m2.session.created` outbox subscriptions |
| M3 (Authorization) | M35 reads from M3 | Permission registry, ABAC predicate registry, three-layer enforcement |
| M4 (Audit & Compliance Log) | M35 writes to M4 | Audit-event emission on every state-mutating route; eraser registration via M4 destruction workflow; audit-denylist registration |
| M5 (Patient & Demographics) | M35 reads from M5 | `m5.patient.created`, `m5.patient.status_changed`, `m5.patient.deceased`, `m5.patient.merged` outbox subscription for per-patient-month metering (post-pseudonymization) |
| M28 (FHIR Gateway) | M35 reads from M28 (Phase 2) | `FhirGatewayMetricsProvider.disclosureMetricsForOrg` for FHIR egress request count metering — Phase 2 quota meter source |
| M29 (External Interfaces) | M35 reads from M29 (Phase 2) | `ExternalInterfaceMetricsProvider.feedHealthForOrg` for HL7 message count metering — Phase 2 quota meter source |
| M32 (AI Platform) | M35 reads from M32 (forward) | `AITokenMeterProvider` for AI token usage — forward-seam deny-stub today, real when M32 locks |
| M36 (Secure Messaging & Alerts) | M35 writes to M36 | All M35 typed alerts emitted via `AlertEmitter` seam; `dunning_recipient_resolver` registered |
| M38 (Terminology) | M35 reads from M38 | ISO 4217 currency code validation (D9) |

### Forward Consumers (Not Patched Here)

The following modules consume M35's published seams. They are not in M35's `dependsOn` — they are *consumed by* M35's seam contracts when those modules lock:

- **M33 (Reporting & Dashboards)** consumes `RevenueMetricsProvider` for the platform-ops revenue dashboard; M33 already locked, the M35 implementation lands as a M33-side adapter when M35 implements
- **M34 (SaaS Tenant Platform — not yet locked)** consumes `SubscriptionStateProvider` + `BillingStatusProvider` for its tenant admin console
- **M28 (FHIR Gateway — locked)** consumes `BillingStatusProvider.isQuotaAvailable` for Phase 2 FHIR egress quotas; consumer-side deny-stub today
- **M29 (External Interfaces — locked)** consumes `BillingStatusProvider.isQuotaAvailable` for Phase 2 HL7 message quotas; consumer-side deny-stub today
- **M32 (AI Platform — not yet locked)** calls `UsageMeteringIngest.ingest` for AI token usage

### Forward-Seam Deny-Stubs Published by M35

**M35 publishes one forward-seam deny-stub.** M35's consumer-side dependencies on M32 (`AITokenMeterProvider`) and M34 (`OnboardingStatusProvider`) are M35-side deny-stubs (M35's `seams/consumed/` folder); they are not deny-stubs *published by* M35 — they are stubs consumed by M35 awaiting real upstream implementations. There are no M35-published seams currently awaiting consumer-side implementation that require M35-side deny-stubs.

### Dependency-Cruiser Rule Additions

```javascript
// In tooling/dependency-cruiser-rules.js
{
  name: 'm35-no-cross-billing-imports',
  severity: 'error',
  comment: 'M35 (subscription billing) must not import from M23/M24 (Medicare/Medicaid claims)',
  from: { path: '^packages/subscription-billing/' },
  to: { path: '^packages/(billing|medicaid-adapters)/' },
},
{
  name: 'm35-stripe-sdk-adapter-only',
  severity: 'error',
  comment: 'Stripe SDK access only via the M35 adapter',
  from: { pathNot: '^packages/subscription-billing/src/stripe/(client|webhook-verifier)\\.ts$' },
  to: { path: 'node_modules/stripe/' },
},
{
  name: 'm35-no-phi-imports',
  severity: 'error',
  comment: 'M35 must not import patient/clinical schemas (PHI boundary D14)',
  from: { path: '^packages/subscription-billing/' },
  to: { path: '^packages/db/src/schema/(patients|encounters|orders|medications|assessments)/' },
},
```

### Boot-Time Seam Registrations Summary

- **6 reader/provider seams published** (`SubscriptionStateProvider`, `BillingStatusProvider`, `UsageMeteringIngest`, `PatientCounterProvider`, `RevenueMetricsProvider`, `PlanCatalogReader`)
- **5 ABAC predicates registered** into M3 (`billing_scope_matches_org`, `platform_billing_scope`, `refund_requires_step_up_approval`, `plan_change_within_period_grace`, `promo_applicable_to_subscription`)
- **25 permission keys registered** into M3 (8 tenant + 17 platform-admin per §4.7)
- **8 inbound outbox subscriptions registered** (§4.12)
- **31 outbox event types published** (§4.11)
- **12 typed alert rules registered** with M36 (§4.10)
- **5 crons registered** (`usage-aggregator`, `stripe-usage-posting`, `subscription-reconciler`, `dunning-engine`, `revenue-snapshot`, `payment-method-expiry-watch`)
- **11 BullMQ queues declared** (§4.9)
- **2 M35-side forward-seam deny-stubs** (`AITokenMeterProvider`, `OnboardingStatusProvider`)

After applying: `bun run arch:fitness` is green (dependency-cruiser boundary check + `check-table-ownership.ts`). The seam registry validates at boot: M35 publishes the 6 reader seams; consumes `OrganizationReader` + `MembershipReader` (from M2), `AlertEmitter` (from M36), `TerminologyProvider` (from M38), the M1 foundation primitives, M4 audit helpers, and the outbox subscriber pattern; `FhirGatewayMetricsProvider` (from M28) and `ExternalInterfaceMetricsProvider` (from M29) are consumed at Phase 2; `AITokenMeterProvider` (from M32) and `OnboardingStatusProvider` (from M34) are forward-seam-deny-stubbed today and wired when the upstreams lock. M33 / M34 are consumers of M35 and not in `dependsOn`.

---

**Lock status:** All 24 decisions (D1–D24) resolved. Module 35 is **buildable now** as a Phase 2 deliverable. The following items are tracked as forward seams, not open decisions: M34 SaaS console consumes `SubscriptionStateProvider` + `BillingStatusProvider` when M34 locks; M32 AI Platform calls `UsageMeteringIngest.ingest` when M32 locks; M28 / M29 Phase 2 quota gates call `BillingStatusProvider.isQuotaAvailable`. ADR-001 (subscription plan model) is closed by D1.

**Phase boundary (binding):** Phase 1 ships nothing visible for M35 — Engrace runs unbilled. The lock-grade spec lands in v0.2 so implementation is unblocked at Phase 2 start, with the proximate trigger being "first paying tenant joins beyond Engrace." Forward-seam deny-stubs (§4.6) and the AI-boundary boot gate (§8.8) ship at M35 lock; the full implementation activates at Phase 2.

**End of M35 Lock-Grade Spec v0.2**

---

## 14. Disaster Recovery, Statelessness & Update Obligations

### 14.1 — M35-F10: DR Tier Declaration (DR-010, DR-013)

#### DR Tier: Tier 3 — Revenue & Reporting

M35 (Subscription Billing) is classified as **DR Tier 3** per `WARDENX_DR_BCP_v0.1.md` §3.1. Rationale: M35 loss impedes billing operations and revenue collection, but does not directly affect patient care, medication administration, clinical documentation, or any Tier-1/2 function. A billing platform outage is a cash-flow event; it is never a patient safety event.

| Scope | RTO | RPO |
|---|---|---|
| Internal engineering target (DR-010) | 24 hours | 1 hour |
| Customer-facing SLA (DR-013) | 48 hours | 4 hours |

The customer-facing SLA (48h RTO / 4h RPO) applies to tenants' ability to view invoices, update payment methods, and have subscriptions reflect their current status. Stripe itself is the authoritative billing system; even if WardenX M35 is fully unavailable, tenants can access Stripe-hosted invoice URLs and the Stripe Customer Portal directly. The WardenX SLA covers WardenX-side access and the Stripe-dispatching pipeline.

**Recovery sequencing:** M35 is recovered after Tier-1 and Tier-2 services in the DR sequencing order: `PostgreSQL primary → Valkey → MinIO → Backend API (Tier 1) → Tier-2 modules → M35 workers + crons`. M35 does not participate in the critical-path startup that enables patient care.

#### 14.2 Degraded-Mode Behavior

When M35 is partially degraded (e.g., Stripe API unreachable, workers down, Valkey unavailable), the following degraded-mode posture applies:

| Degradation scenario | M35 behavior | Patient care impact |
|---|---|---|
| **Stripe API unreachable** | Outbox events accumulate in PostgreSQL; `stripe-dispatcher` retries with exponential backoff (§4.9.1). Subscriptions stay in current state (no new activations or cancellations until Stripe recovers). Webhook handler queue backs up. | None — M35 is Tier 3; clinical care does not depend on Stripe availability. |
| **Valkey unavailable** | BullMQ queues stall (BullMQ depends on Valkey). In-flight jobs may be lost if Valkey state is unrecoverable; jobs not yet dequeued re-run after recovery (idempotent consumers handle duplicates). Inbound `Idempotency-Key` lookups fail open (M1 middleware falls back to pass-through if Valkey is unavailable per M1's degraded-mode spec). | None. |
| **M35 workers all down** (crons and BullMQ consumers stopped) | No outbound Stripe API calls until workers recover. No dunning advancement. No usage aggregation. Webhook events queue in `stripe_webhook_event` (unprocessed). Revenue snapshot skips the missed period (re-triggerable via `/admin/revenue/snapshots/compute`). | None. |
| **PostgreSQL unavailable** | M35 routes return 503; no state mutations possible. Stripe continues billing per the last-known subscription state. `stripe_webhook_event` inserts fail (Stripe will retry webhook delivery per Stripe TOS up to 72 hours). | None directly from M35. |
| **M35 fully unavailable (all of the above)** | Tenant billing screens return 503. Stripe continues operating independently. Tenants can access Stripe-hosted invoice URLs from prior emails. `platform_admin` can use Stripe Dashboard for emergency operations. | None. |

**Billing blocked during degraded mode:** If M35 is degraded while a dunning sequence is active, the dunning engine does not advance. This is the *safer* default — tenants are not suspended due to a system outage. Recovery runs the dunning engine pass immediately; stage transitions are replayed from where the sequence left off.

**Platform commitment during M35 degradation:** WardenX will not cancel or suspend any tenant subscription due to a failure to process a Stripe webhook caused by an M35 outage. Subscription state corrections are applied after recovery via the reconciler cron.

#### 14.3 Statelessness Affirmation

M35 is **stateless at the application layer**. The M35 backend process (`apps/backend`) holds no in-memory state that cannot be lost:

- All subscription state, invoice mirrors, dunning state, usage aggregates, pseudonyms, and Stripe audit records are in **PostgreSQL** (the system of record).
- BullMQ job metadata is in **Valkey db 1** (ephemeral; recovered from PostgreSQL state on re-enqueueing).
- Inbound `Idempotency-Key` cache is in **Valkey db 0** (ephemeral; 24h TTL; on loss, duplicate requests are processed again — all M35 handlers are idempotent, so this is safe).
- The XState subscription and dunning machines are reconstituted from PostgreSQL (`subscription.status`, `dunning_state`) on each invocation; they carry no in-memory state across requests.
- Stripe is the authoritative source of Customer / Subscription / Invoice / PaymentMethod / UsageRecord state; M35 mirrors are rebuilt by the reconciler if PostgreSQL state is lost or stale.

**Valkey-ephemeral / PG-system-of-record posture:** Valkey loss → workers stall, idempotency cache clears → safe recovery by re-enqueueing from PostgreSQL state and allowing duplicate-but-idempotent replays. PostgreSQL loss is the only non-trivially-recoverable scenario; it is covered by PG WAL shipping + point-in-time recovery per the DR BCP (RPO 1h internal, 4h customer SLA).

#### 14.4 — M35-F18: DR/INT Document Update Obligations (DR-073, INT-048)

By shipping Module 35 with its Stripe integration surface and a new partitioned table (`usage_event`), two standing update obligations are triggered:

**DR-073 — DR/BCP document update on new external dependency:**

M35 adds the **Stripe API** as a new external dependency with a billing-critical path. The DR/BCP document (`WARDENX_DR_BCP_v0.1.md`) must be updated before M35 ships to Phase 2 to record:

1. Stripe as a Tier-3 external dependency in the DR dependency matrix.
2. Stripe-specific failure mode: Stripe API degradation → M35 dispatcher queue backs up → subscriptions freeze in current state → acceptable (Tier 3, 24h RTO) if recovered within the RTO window.
3. Stripe-specific recovery procedure: On recovery, the dispatcher drains the backlog; the reconciler confirms WardenX ↔ Stripe state consistency; any subscription that should have transitioned during the outage is corrected by the reconciler.
4. The `stripe_api_call_audit` table (append-only, platform retention) as the forensic trail for Stripe-side operations during an outage window.

The DR-073 update is **owned by the M35 tech lead** and must be reviewed by the platform-ops rotation lead before the M35 Phase 2 build begins. Acceptance-checklist item §12.11 tracks this.

**INT-048 — Integrations document update on new external vendor surface or new partitioned table:**

M35 adds:

1. **Stripe** as a new integration surface. The `WARDENX_INTEGRATIONS_v0_1.md` integrations table already includes a row for Stripe (row 11); however, the detailed integration spec (§6.11 in WARDENX_INTEGRATIONS) must be updated to confirm: (a) M35's Stripe surface is not BAA-bearing (per D14); (b) the restricted-key permissions (§8.9); (c) the webhook endpoint (`POST /v1/webhooks/stripe`) and HMAC verification posture; (d) Stripe Tax as the sole tax engine (D10); (e) the Stripe Test Clock usage in CI. This update is an **augmentation of the existing row**, not a new row.

2. **`usage_event` (partitioned table)**. The integrations document's data-flow section must note that `usage_event` is partitioned by month and that old partitions are archived after 24 months. This informs the backup/restore procedure (restoring a `usage_event` partition is not identical to restoring a regular table), the DDL-legality checker (`check-ddl-legality.ts` must allow `CREATE TABLE ... PARTITION OF` for M35), and the eraser path (the eraser must drop each partition independently per §3.7).

The INT-048 update is **owned by the M35 tech lead** and reviewed by the platform-ops rotation lead. Acceptance-checklist item §12.11 tracks this alongside the DR-073 update.

### 12.11 — DR and Integrations Update Obligations

> *(Appended to §12 Acceptance Sign-Off Checklist)*

- [ ] **DR-073:** `WARDENX_DR_BCP_v0.1.md` updated to add Stripe as a Tier-3 external dependency, including failure mode, recovery procedure, and audit trail reference — reviewed by platform-ops lead
- [ ] **INT-048 (Stripe):** `WARDENX_INTEGRATIONS_v0_1.md` §6.11 Stripe detail updated with M35-specific posture (non-BAA, restricted-key, webhook HMAC, Stripe Tax, CI test clocks)
- [ ] **INT-048 (partitioned table):** `WARDENX_INTEGRATIONS_v0_1.md` data-flow notes updated for `usage_event` monthly partitioning; `check-ddl-legality.ts` allows `PARTITION OF`; eraser path confirmed to handle partitions
- [ ] **OPS-043:** Three alert YAML files present in `alerts/`; three runbook stubs present in `runbooks/`; alert firing tested in staging Prometheus/Alertmanager before Phase 2 go-live
