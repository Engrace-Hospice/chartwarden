# Adapter Expansion Plan — full claim cycle with multiple clearinghouses

**Date:** 2026-10-11 · **Status:** proposal (nothing here is approved or built)
**Requirement (user, 2026-10-11):** "we want full claim cycle with the clearinghouses" — every stage from
eligibility to posted payment must run through a clearinghouse adapter, and Stedi is only the first.

Authority: [`WARDENX_INTEGRATIONS_v0_1.md`](../../architecture/WARDENX_INTEGRATIONS_v0_1.md) §3.1 (adapter package
model), §2 (inventory), [ADR-0020](../../adr/ADR-0020-integration-governance.md),
[ADR-0028](../../adr/ADR-0028-adapter-package-codepaths.md). Where this plan disagrees with them, they win.
Vendor names not already in the repo are **candidates from general market knowledge, not verified** (hospice
support, pricing, BAA terms all unchecked).

---

## 1. Short answer

Yes. The repo already has the way to add adapters: **one `packages/<vendor>-client/` (or `<domain>-adapters/`)
workspace per integration, exposing a typed interface; modules import only the interface; a registry or
env-gated selector picks the implementation** (INTEGRATIONS §3.1). Adding a vendor is a new implementation
behind the same interface. Anti-pattern: a module calling `fetch()` on a vendor URL.

It is applied consistently by intent, **not by shared code**:

| Package | Selection | Shape |
|---|---|---|
| `medicaid-adapters` | `MedicaidAdapterRegistry` per state, validated against M40 catalog at boot (fails closed) | Oregon real; WA/ID/CA/NV deny-stubs |
| `evv-aggregators` | `StateAggregatorRegistry` per state+vendor, `extraAdapters` injection | Sandata real; HHAeXchange/Tellus/CareBridge scaffolds |
| `telehealth-client` | `TelehealthProvider` + vendor enum | Daily.co real; two scaffolds |
| `routing-client` | interface + 2 adapters | Mapbox, OSRM |
| `cahps-vendors` | per-vendor folders | 5 vendors incl. manual CSV |
| `x12-837-client` | `X12WorkerHttpPort` + per-**MAC-jurisdiction** portal clients | pyx12 sidecar; NGS J6 only, six deny-stubs |
| `x12-835-client` | `parse-835`, `parse-277ca`; worker port `NO_X12_835_PORT` | M25 835 worker port undefined in every environment |
| M22 fax | `FAX_PROVIDER` env selector | port, no vendor |

**Gaps that block a full cycle across several clearinghouses**

1. **The claims seam is keyed on the wrong axis.** `x12-837-client` selects by MAC jurisdiction and assumes the
   pyx12 sidecar. A clearinghouse is not a jurisdiction: any of them can route to any MAC. We need a
   `ClearinghouseTransport` chosen **per ProviderEntity**, with MAC jurisdiction as payer metadata.
2. **The cycle is split across two packages and one undefined port.** Outbound is `x12-837-client`, inbound is
   `x12-835-client`, and the 835 worker port is unbound everywhere. A clearinghouse gives both directions
   through one account, so the port must cover both.
3. **No common adapter contract.** Breaker, `DegradedError`, retry, telemetry are re-implemented per package
   (`iqies-client`, `routing-client`, `telehealth-client` each have their own `circuit-breaker.ts`).
4. **No "clearinghouse accepted" state** distinct from "payer accepted"; no per-entity vendor setting; no
   enforcement gate against direct vendor `fetch()`; the INTEGRATIONS §2 adapter column is wrong for 15 of 33
   rows.

## 2. The full claim cycle — what the transport port must cover

Every stage is a port method (or a clearly owned non-port step), so a new clearinghouse is "done" only when
the whole row set passes conformance. "Today" is the state of `main`; module owners per the manifest.

| # | Stage | X12 / mechanism | Port method | Owner | Today |
|---|---|---|---|---|---|
| 1 | Eligibility / benefit-period check | 270/271 (HETS or clearinghouse) | `checkEligibility` | M5 → M23 | HETS codec + CORE MIME, bound only if `M23_HETS_TRANSPORT` set; MBI never persisted |
| 2 | Pre-submission validation | WardenX §11.A rules (+ clearinghouse edits as a second validator) | `validateOnly` (dry-run) | M23 | internal only; Stedi edits run before provisioning, so usable as validator |
| 3 | NOE (election notice, day-5 deadline) | 837I TOB 81A | `submitNotice` | M23 / DDE queue | builder exists; sandbox needs `BHT06=RP`, CL102 |
| 4 | Claim submission | 837I TOB 81x/82x | `submitClaim` | M23 | builder fixed in Phase 3; Stedi rules (freq 2/3, `DTP*096*TM`, CLM02 = Σ lines) not yet applied |
| 5 | Interchange / syntax ack | 999 / TA1 | `fetchAcknowledgments` | M23 | `acks/` parser |
| 6 | Claim acknowledgment (clearinghouse then payer) | 277CA; clearinghouse-accepted vs payer-accepted | `fetchAcknowledgments` | M23 → M25 | `parse-277ca`; **single ack state, needs split** |
| 7 | Rejection / RTP handling | 277CA reject, DDE RTP | — (workflow) | DDE queue (M23) | queue built (ADR-0052); human corrects in DDE, WardenX never holds DDE creds |
| 8 | Adjustment / replacement | 837I freq 7 (`REF*F8`) | `submitClaim` (freq 7) | M23 | not supported; Stedi/CMS conflict open (Q17) |
| 9 | Cancel | 837I freq 8 | `submitClaim` (freq 8) | M23 | not supported |
| 10 | Remittance | 835 ERA | `fetchRemittances` | M25 | `parse-835` exists; worker port unbound |
| 11 | Payment posting and reconciliation | 835 CLP/CAS/BPR → ledger → deposit | — (M25 service) | M25 | partially built; needs 835 feed to exercise |
| 12 | Denial worklist, appeals, correction | CARC/RARC → worklist; appeal by payer channel | — (workflow) | M25 | worklist exists; appeals not EDI |
| 13 | Secondary / crossover (Medicaid, dual) | 837I secondary with COB from 835 | `submitClaim` (secondary) | M23/M24 | not built |
| 14 | NOTR (discharge / revocation) | 837I TOB 81B | `submitNotice` | M23 | builder exists; hour is `DTP*096*TM` |
| 15 | Status inquiry (stuck claim) | 276/277 or polling | `fetchClaimStatus` | M23 | not built; Stedi polling endpoint available |
| 16 | Event intake (push) | webhook signed per destination; ordering not guaranteed | `verifyAndParseEvent` | platform | not built; Stedi events carry references only → fetch |

Hospice-specific, not handled by any clearinghouse (Stedi confirmed no hospice rules): NOE timeliness, benefit
period logic, revenue-code/HCPCS pairing, Q5006 reporting, PM modifier. These stay in WardenX §11.A.

## 3. Plan

Guiding rule: extract the shared contract from what exists, prove it against **two** implementations, then add
vendors. No speculative framework (YAGNI).

### Track A — the port and the plumbing (before a second vendor)

| # | Work | Output | Gate |
|---|---|---|---|
| A1 | **ADR-0053 `ClearinghouseTransport`.** Methods from §2: `checkEligibility`, `validateOnly`, `submitNotice`, `submitClaim`, `fetchAcknowledgments`, `fetchRemittances`, `fetchClaimStatus`, `verifyAndParseEvent`. Returns the existing `X12WorkerResult` envelope. Add ack states `clearinghouse_accepted` / `clearinghouse_rejected` / `payer_accepted` / `payer_rejected`. MAC jurisdiction becomes payer metadata. | ADR + interface (new `packages/clearinghouse-client`, or inside `x12-837-client`; decide in ADR under ADR-0028 code-path rules) | `arch:adr-docs`, `arch:parity` |
| A2 | **Conformance suite** covering all 16 stages for any adapter: idempotent resubmit, 999 reject, 277CA reject, RTP, freq 7/8, 835 parse incl. CAS, event-then-fetch with out-of-order events, breaker open → `DegradedError`, no MBI in logs. | `conformance.ts` + per-adapter runner | non-live tests |
| A3 | **Per-ProviderEntity vendor setting, platform-set** (`clearinghouse_vendor` + credential slot via the M24 credential store; `M24_CREDENTIAL_ENCRYPTION_KEY` must be set in prod or `POST /billing/mac-credentials` returns 503). Boot validation like `MedicaidAdapterRegistry`: active vendor with no adapter fails closed. | migration + manifest (`.ts` and `.cjs`) + code mirrors | `arch:migration-numbering`, `arch:tenancy`, `arch:manifest-mirror` |
| A4 | **Shared adapter kit** (breaker, `DegradedError`, retry/jitter, telemetry): extract from the three existing `circuit-breaker.ts` copies; migrate them behind unchanged APIs. | package + 3 migrations | typecheck, existing tests |
| A5 | **Define the M25 835 worker port** and bind it to the transport's `fetchRemittances` (closes the "undefined in every environment" gap). | port + wiring in `apps/backend/src/index.ts` | grep factory; live suite |
| A6 | **Ack-state split** in M23/M25 (schema + UI chips + DDE queue triggers). | migration + code | live suite on private pg18 |
| A7 | **`arch:adapter-boundary` gate**: no `fetch(` or vendor hostnames outside `*-client`, `*-adapters`, `*-vendors`; ratchet allowlist that only shrinks. | script + `arch:fitness` | itself |
| A8 | **Fix INTEGRATIONS §2/§6**: regenerate adapter column from `ls packages/`; add Stedi (and each clearinghouse) row and §6 contract. | doc | `arch:architecture-docs` |

### Track B — clearinghouse adapters (each must pass A2 in full)

| # | Work | Depends on | Notes |
|---|---|---|---|
| B1 | **Direct-MAC re-expressed as a transport** (pyx12 sidecar + NGS J6 portal behind A1). Proves the port with a non-Stedi implementation before it is declared stable. | A1, A2 | no new vendor risk |
| B2 | **Stedi adapter, full cycle** (Phase 4 + 5 merged into "run the whole table in §2"): raw X12 for NOE/NOTR, JSON or raw for claims, OAuth integrated account, event-then-fetch with polling reconciliation, eligibility, 835. Gated on call answers Q14 (provisioning), Q16 (enrollment), Q17 (freq 7/8). Apply the sandbox-found edit rules to the claim and notice builders first (small PR, still awaiting your yes). | A1–A6, Stedi call | enrollment for Medicare Part A (`MDCKC`/`12M41`) is required; confirm timing |
| B3 | **Second commercial clearinghouse selection spike** (suggested first candidates: Availity, Office Ally; others: Waystar, Optum/Change, Claim.MD, Trizetto). Written comparison: hospice 837I + NOE/NOTR support, 277CA/835 return path, API vs SFTP, BAA, sandbox, price at about 100–170 txns/month/tenant (ADC 30–50). | none | decide by a tenant need, not speculation |
| B4 | **Second clearinghouse build** per B3, against A2 unchanged. | B3, A2 | |
| B5 | **Eligibility fan-out**: HETS default, clearinghouse alternate per tenant; reuse the 270/271 codec. | A1 | |

### Track C — non-claim adapter families (independent, demand-driven)

| # | Work | Trigger |
|---|---|---|
| C1 | Outbound messaging: Twilio SMS/Voice, Postmark, Web Push. Today outbound email is a production no-op; no outbound Twilio client exists. | after A4 |
| C2 | Fax vendor behind `FAX_PROVIDER` (candidates Documo, Sfax, Phaxio; BAA first). | tenant needs outbound fax |
| C3 | Medicaid state adapters (WA, ID, CA, NV, then others): replace deny-stub. Crossover/secondary (§2 row 13) rides on this. | tenant in that state |
| C4 | EVV Phase-2: HHAeXchange, Tellus, CareBridge. | tenant in a mandating state |
| C5 | Accounting/payroll alternates (QuickBooks, ADP, Paychex). | tenant demand |
| C6 | HL7/lab inbound: build `hl7-worker` vs integration engine (Mirth/Rhapsody) vs Redox. | first ADT/lab customer |
| C7 | Stripe transport; DoseSpot sandbox verification (field names unverified). | before GA |

### Track D — checklist for any new adapter (PR template)

1. INTEGRATIONS §2 row and §6 contract **before** code.
2. Package under the right `codePaths` in the manifest (`.ts` + `.cjs`); `arch:parity`, `arch:manifest-mirror`.
3. Implements the shared interface; no vendor SDK types leak.
4. Credential scope decided up front (platform / tenant / ProviderEntity); encrypted at rest, never logged.
5. Fails closed: unconfigured = unbound (deny-stub / `NOT_WIRED`), never a silent no-op.
6. PHI minimisation; MBI confinement for eligibility and claims.
7. BAA executed before production PHI; §5 register entry.
8. Passes A2 conformance; live suite on a private `pgvector/pgvector:pg18` container if it touches DB/outbox;
   `package.json` script **and** `ci.yml` job.
9. Sandbox/test mode with synthetic data only; rotate test keys after use.
10. Wired in `apps/backend/src/index.ts` (grep the factory — bound is not computing).

## 4. Order

1. **A1 + A2** (port and full-cycle conformance) — small, shapes Stedi correctly.
2. **Edit-rules PR** for the claim/notice builders (small; unblocks sandbox validation as a second validator).
3. **B1** direct-MAC, **A3**, **A4**, **A5**, **A6** — can overlap the Stedi call.
4. **B2 Stedi full cycle** once Q14/Q16/Q17 resolve.
5. **A7, A8**, then **C1** in parallel (independent of billing).
6. **B3 → B4** and **C2–C7** strictly on tenant demand.

## 5. Risks and open questions

- **Over-fitting the port to Stedi** (event-then-fetch, JSON route). B1 before declaring the port stable.
- **Enrollment is per payer and per provider, not per adapter.** The port must expose "not enrolled" as a
  first-class state; Stedi shows ENROLLMENT_REQUIRED for Medicare Part A 837I/835/eligibility.
- **Adjustments:** Stedi docs say Original Medicare does not accept freq 7/8, while their edit accepts it with
  `REF*F8`. Confirm with Stedi and the MAC before building stages 8–9.
- **Metered CI:** each live suite adds a job; batch pushes.
- **Decided (2026-10-11):** WardenX resells one clearinghouse (Stedi first), so the vendor choice is
  **platform configuration**, not a tenant-facing setting. A3 therefore stores the selection per
  ProviderEntity but writes it from an operator/platform surface (M19/M40), never a tenant admin screen. A
  tenant-chosen clearinghouse stays possible later through the same port without a redesign.
- **Open:** where the shared kit lives (A4) under ADR-0028 code-path rules.
