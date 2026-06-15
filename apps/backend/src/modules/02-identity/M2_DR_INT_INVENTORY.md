# Module 2 (Identity & Org) — DR Tier + Integration Inventory (M2-T10)

Per-module declaration required by the Phase-1 Definition-of-Done (`docs/IMPLEMENTATION_ROADMAP.md`
§DoD): "DR tier + INT inventory declared; degraded-mode behavior documented where on a cross-phase
path." Authoritative sources: `docs/architecture/WARDENX_DR_BCP_v0.1.md` (DR tiers) and
`docs/architecture/WARDENX_INTEGRATIONS_v0_1.md` (integration catalog).

## 1. Disaster-Recovery Tier — **Tier 1 (Critical patient care)**

Identity is the gateway to every clinical workflow: without sign-in, session issuance, and
org-context binding, no clinician can reach eMAR, orders, or the chart. The DR_BCP §3.1 service
matrix already classifies the **Backend API**, **PostgreSQL primary (read+write)**, and **Valkey
(session)** — all on M2's hot path — as **Tier 1**. M2 inherits that tier.

| Target | Internal | Customer SLA |
|---|---|---|
| RTO | 1 hour | 2 hours |
| RPO | 5 minutes | 15 minutes |

### Degraded-mode behavior

- **Valkey (session cache) unavailable** → session lookups fall back to the PostgreSQL `session`
  table (slower hot path, target p95 relaxed from <10 ms cached). Auth stays available.
- **Identity DB unavailable** → no new logins (the reason M2 is Tier 1, not Tier 2). Already-issued,
  cached sessions continue to validate until expiry.
- **MFA factors** — TOTP (local secret) and WebAuthn/passkey (local authenticator) require **no
  external service**, so step-up survives any third-party outage. The SMS factor (M36/Twilio) is an
  accessibility fallback only and degrades to TOTP/passkey when unavailable (spec §5.4).
- **Org status gating** — a `suspended` org issues only read-only compliance sessions; a `closed` org
  refuses sign-in (spec §8.1 org status machine). This is enforced at issuance, independent of DR state.

## 2. Integration Inventory

### 2.1 Owned by M2

| # | Integration | Direction / protocol | PHI | BAA | Credential | Adapter | INT Tier |
|---|---|---|---|---|---|---|---|
| 32 | HaveIBeenPwned (HIBP) breach check | Outbound query · REST (k-anonymity, SHA-1 prefix) | No | No | platform (keyless) | `packages/auth` (hibp adapter) | Tier 4 |

- **Use:** password breach feedback during credential set / reset (spec §5.2 "live policy + breach
  feedback"). Only a SHA-1 prefix leaves the boundary; the full hash and password never do.
- **Degraded mode:** **fails open** — on HIBP unavailability the breach check is skipped and the
  password policy still enforces length/complexity. A breach lookup never blocks login or enrollment.

### 2.2 Consumed via Module 36 (Notifications) — not M2-owned

These touch auth flows but are **owned by M36** in the catalog; M2 consumes them through M36's
notification seam/outbox (no direct vendor import in M2; no `dependsOn` edge added):

| # | Integration | Auth touchpoint | PHI | Owner |
|---|---|---|---|---|
| 12 | Twilio — SMS | TOTP SMS fallback (accessibility, spec §5.4) | No (by rule) | M36 |
| 14 | Postmark — email | Invitation + email-verification delivery (spec §5.1–5.2) | No (by rule) | M36 |

The "no PHI in payload" rule (notification builder, architecture §36) means these carry only a
generic notice + an authenticated deep link, never clinical content.

## 3. Right-to-Erasure (eraser)

M2 registers a real eraser for the **`identity`** data class (two_factor / passkey enrollments +
pending invitations) — see `erasers/identity-eraser.ts`, wired through the composition root's
`registerModuleErasers` hook. `validateErasers()` passes at boot with the real eraser standing over
the Phase-0 deny-stub. Full destruction-certificate workflow lands with M4.
