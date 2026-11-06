# ADR-0108 — Claims-billing add-on entitlement: a platform add-on, block new work and finish in-flight, census by pull, Stripe deferred

- **Status:** **Proposed** (2026-11-05)
- **Date:** 2026-11-05
- **Related:** Module 35 (subscription billing; amends its D21), Module 5 (patient), Modules 23 / 24 / 25 / 41 (Medicare, Medicaid, remittance, commercial billing), ADR-0025 (M34↔M35 seams), ADR-0053 (clearinghouse transport), ADR-0100 (M41).

## Context

Claims billing (claim assembly and submission, eligibility checks, DDE work, reopenings) is a separately sold product. Until now any tenant with any plan could use it. The owner decided (2026-11-05):

1. It is a separate, platform-owned add-on (M35 D11: no tenant overlay), slug `claims_billing`, priced per **active patient per month**. Any plan tier can hold it.
2. Without the add-on a tenant may not **start** new claims work, but everything already in flight **finishes**. CMS notices (NOE, NOTR, transfer notices) and voids / cancels stay open: they have 5-day deadlines and a missed void is an overpayment.
3. Count now, charge later. Stripe has no subscription or meter wiring in this repo (`packages/subscription-billing/src/stripe/http-transport.ts` has no subscription operations, and `subscription.stripe_subscription_id` is never written), so charging is out of scope.

## Decision

- **D1. Data (M35-owned, migrations 1320 and 1321).** `addon` is a platform catalog shaped like `plan` (slug, name, entitlement key, meter event type, unit price, currency, active flag, validity, nullable Stripe ids), read-all to the app role and written only by `chartwarden_admin`; it is seeded with the one `claims_billing` row with no price (D7). `subscription_addon` is tenant-scoped: organization, subscription, add-on, status (`trialing | active | canceled`), trial end, start, end, cancel instant, granting membership, canceling membership (migration 1325: the platform tx sets no `app.user_id`, so the row names the operator), grant reason and a nullable Stripe subscription-item id. At most one trialing/active row per (organization, add-on). RLS is enabled and forced, and the app role gets a **SELECT-only** policy and grant: grants and cancels go only through M35's platform runner, so a tenant cannot grant itself the add-on. Both tables carry the M4 write-audit trigger. A new `usage_event_type` value, `billing_addon_patient`, keys the monthly aggregate (in its own migration, the 1305 precedent).
- **D2. Granting.** Platform ops grant, start a trial of (with a future trial end) or cancel the add-on per subscription: `GET /api/admin/addons`, `GET|POST /api/admin/subscriptions/:id/addons`, `POST /api/admin/subscriptions/:id/addons/:addonId/cancel`. They reuse `subscription.admin.read` / `subscription.admin.write`, the platform-billing scope, a fresh step-up and an `Idempotency-Key`; no new permission key. Each write emits `m35.claims_billing_addon.granted` or `.canceled` (ids, status, effective instant only) through the catalog-validating publisher in the same transaction. An expired trial is closed when a new grant arrives.
- **D3. Entitlement rule.** An organization is entitled when its latest add-on row is trialing or active, has not reached its trial end or end, **and** the subscription it belongs to is `trialing`, `active`, `past_due` or `at_risk`. Otherwise the reason is `never_purchased`, `lapsed`, `subscription_suspended`, `subscription_canceled` or `subscription_paused`. Dunning alone does not block work; suspension does.
- **D4. Read path.** A leaf seam, `ClaimsBillingEntitlementReader.entitlementForOrg(orgId)` (owner M35, throwing deny-stub until M35 registers the Drizzle reader on a db boot). There is no cache: the route gate memoises the answer per request, so a grant or a cancel takes effect on the next request. Other backend code calls `isClaimsBillingEntitled(orgId)` from `apps/backend/src/bootstrap/claims-billing-gate.ts`, which applies the enforcement mode (D6).
- **D5. What is blocked.** New work only: claim assemble / create, submit, replace and commercial ready (M23, M24, M41); eligibility checks (M23, M24, M41, and the M23 auto-refresh worker); DDE item create, record-submission, submit-via-provider and retry; M25 reopening create and submit. Everything else stays open: reads, draft edit and validate, void / cancel / abandon, NOE / NOTR / transfer-notice create, submit and correct, acknowledgments, polls, claim status, remittance, appeals and ADR responses, configuration, internal seams and platform admin. A new-work path fails **closed** (503 `BILLING_ENTITLEMENT_UNAVAILABLE`) if the entitlement read fails; an in-flight path never calls it.
- **D6. Enforcement mode.** `CLAIMS_BILLING_ENFORCEMENT=off|shadow|enforce`, default `shadow`. `shadow` evaluates and logs a would-deny (organization id and route or queue only) but lets the work through; `enforce` refuses. Boot refuses a mode other than `off` while the seam is still the deny-stub.
- **D7. Where the gate sits.** At the route-mount boundary: an `onRoute` hook, active only while one billing module mounts, appends the gate after the route's own permission and ABAC handlers. Each module has a `route-classes.ts` with ordered rules (`new_work | open`); a test enumerates every route of the four modules and fails on an unclassified mutating route or a rule that matches nothing. A refused request gets 402 `CLAIMS_BILLING_ADDON_REQUIRED` with the reason as the detail code. Queued work is **held, not failed**: the M23 claim submit / submit-retry / eligibility-refresh workers and the M24 submit / submit-retry workers (M24 has no eligibility worker) move a job back to delayed (about 15 minutes) without spending an attempt or reaching a DLQ, and the M41 drain leaves an unentitled org's rows queued. NOE / NOTR / transfer-notice submission, acknowledgment, poll and remittance workers and every outbox consumer are untouched. **Voids pass the gate.** Building a void is an open route, but it is sent through the same submit route and submit queues as a new claim; so the M23 and M24 submit rule carries an exemption (`RouteClassRule.exempt`) and the submit workers pass one to the hold: when the org would be refused, the claim named by the route id / job is read under that org (RLS) and a stored TOB 818 goes through. The TOB is never taken from the request, and a failed read gates as normal (fail closed).
- **D8. Census by pull (amends M35 D21).** M5 publishes `PatientCensusReader.activePatientIdsPage(orgId, {after, limit})` (patients with status `active`, ids only). An M35 sweep (`m35.patient-census`, every 6 hours through the existing M35 fan-out) pages it for each org with a live add-on, or one that ended within the last sweep interval (one final pass, so a patient admitted after the end is not counted), pseudonymizes each id with the billing HMAC key (D6 of M35: raw ids stay in memory, never in an M35 table) and inserts `patient_active_period` rows idempotently. The period key comes from the same window helper as the usage aggregator (`usageWindowFor`), and the existing deceased/merged consumer uses it too. M5 does not push `m5.patient.created` / `.status_changed` to M35, which M5 refused; a pull needs no new coupling. `PatientCounterProvider` counts distinct pseudonyms under the newest key epoch. `aggregateAddonForOrg` writes the month's count to `usage_period_aggregate` as `billing_addon_patient`. A count that differs from M5's own by more than 1 % is logged as a reconcile metric.
- **D9. Visibility, not charging.** Admin sees the add-on panel on the subscription and the add-on count on the usage drill-down; the tenant sees `claimsBilling` on `GET /api/v1/billing/status` and a notice atop the four billing areas, with create / submit actions disabled. Stripe charging (subscription items, meter posting, the `stripe_*` columns) is deferred until M35's Stripe subscription wiring exists.

## Consequences

- A tenant without the add-on can still meet every CMS deadline and void (TOB 818) a claim already sent; a replacement (TOB 817) is a new submission and needs the add-on, like every other new submission.
- Shadow mode lets operations see who would be blocked before turning enforcement on. Flipping to `enforce` is an operator decision per environment.
- The census adds one paged M5 read every 6 hours per add-on org; an org that never held the add-on costs nothing.
- Adding a mutating route to M23, M24, M25 or M41 now needs a route-class rule, or the classification test fails.
- Until Stripe wiring lands, the add-on price is informational and the count is shown but never billed.

## Amendment 2026-11-06 — repurposed: the gate follows the tenant's clearinghouse choice; no add-on, no fee

**Decision (product owner, 2026-11-05).** There is no separate claims-billing fee. A tenant may START new claims and eligibility
work exactly when it has chosen `stedi` or `claimmd` and that config is `active` (ADR-0053 amendment 2026-11-06); `outside`,
nothing chosen, and a `draft` or `verified` config are refused. The carve-outs (NOE / NOTR / transfer notices, voids, in-flight
work, reads and configuration), D5's list of blocked work, D6's `CLAIMS_BILLING_ENFORCEMENT=off|shadow|enforce` semantics and
D7's mount-boundary gate, worker hold and void exemption are unchanged.

**What changed.** D1-D3 (the add-on, its grant and its entitlement rule) no longer decide anything. The `ClaimsBillingEntitlementReader`
seam is now owned and registered by M23 and decides from `TenantClearinghouseReader` (D4): `{ entitled: true }` for an active
transmitting config, else `clearinghouse_not_chosen`, `clearinghouse_outside` or `clearinghouse_not_active`. The refused request
is still 402 `CLAIMS_BILLING_ADDON_REQUIRED` (the code keeps its historical name so the shipped client keeps working; renaming
it belongs with the UI slice) with the reason as the detail code. An organization named in `CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS`
that has no row is entitled (the platform vendor serves it). `GET /api/v1/billing/status` `claimsBilling.entitled` / `reason`
come from the same decision, so the notice says what the gate does.

**The subscription still blocks (owner decision D1, 2026-11-06).** A suspended, paused or canceled ChartWarden subscription still refuses NEW claims and
eligibility work, whatever the clearinghouse says: the refused request is the same 402 with the detail code `subscription_suspended`, `subscription_paused` or
`subscription_canceled`. M23's entitlement decision reads it through the `SubscriptionWorkBlockReader` seam (owner M35, which reuses the D3 status rule; an org with no subscription row is not
blocked) and asks it first, then the clearinghouse. NOE / NOTR, voids and in-flight work keep running, as before. A failed read of either fails the gate closed.

**Kept, expand-only.** The `addon` and `subscription_addon` tables, their grant / cancel routes, the `m35.claims_billing_addon.*`
events and D8's census pull (`patient_active_period`, `billing_addon_patient`, the sweep) are untouched: the census stays
because pricing reuses it as a meter. Granting the add-on now changes nothing the gate sees; the census sweep still selects
orgs by a live add-on row, which slice 2 (pricing) re-points. Retiring the grant routes is slice 2's call.
