# WARDENX_UI_MEDICAID_TRADING_PARTNER_CREDS

Version: 1.0
Status: Screen Specification
Module: Medicaid Trading Partner Credentials (M24)

---

## Purpose

The Trading Partner Credentials settings surface stores and rotates the per-ProviderEntity,
per-state, per-channel submission credentials that M24 uses to reach a state Medicaid agency or
its contracted CCO/MCO. It is the Medicaid equivalent of M23's MAC submitter credential, modeled
as `state_medicaid_trading_partner_credential` — one row per
`(provider_entity_id, state, channel)` where `channel ∈ {direct_mmis, cco_clearinghouse, sftp,
portal}`. The `client_secret_cipher` is encrypted under the per-tenant DEK (M1 §6, KMS-wrapped);
the route returns masked values to the UI, and the secret is never logged, never in audit
value-capture, never in test fixtures.

This is where an administrator (or M34's setup wizard, which reads through the
`MedicaidTradingPartnerAdmin` seam) registers a new state/channel credential, rotates a
client secret, and activates or retires a credential against its effective window.

---

## Primary Users

- Administrator
- Billing Manager
- IT / Integration Admin (M34 setup wizard)
- Compliance Officer (read / audit)

---

## Layout Pattern

Use Admin Settings Layout.

```text
Page Header
Settings Sidebar (Provider Entity → State → Channel)
  |  Settings Content (credential record: client_id, masked client_secret, window, status)
  |  Right: Help / Impact (which claims route here · rotation guidance · channel match)
```

Categorized configuration with a live explanation of impact: the sidebar groups credentials by
Provider Entity, then state, then channel; the content panel edits one credential; the right rail
explains which submission channel and which claims depend on this record and what a rotation will
affect.

---

## Settings Sidebar

Grouped configuration tree:

- **Provider Entity** (CCN-anchored) →
- **State** (registered adapter set; Oregon active in Phase 1, WA/ID/CA/NV deny-stubbed) →
- **Channel** — `direct_mmis` · `cco_clearinghouse` · `sftp` · `portal`; the channel set is
  constrained to the M40 the `m24_channel` enum *(the once-planned `state_medicaid_program.channel_options[]` table/column was never built)* for that state.

Each leaf shows a status dot (`Active` / `Inactive`) and the next rotation-due indicator.

---

## Credential Record (Settings Content)

Per `state_medicaid_trading_partner_credential` row:

- **`client_id`** — shown in full (not a secret); IBM Plex Mono.
- **`client_secret_cipher`** — displayed **masked** (e.g. `••••••••••••last4`); never revealed.
  Editing replaces the secret (write-only field); on save it is KMS-wrapped under the per-tenant
  DEK.
- **SFTP-key channels** — `sftp_key_cipher` handled the same way (masked, write-only); the
  `client_secret` field is nullable for key-based channels.
- **Effective window** — `active_from` ≤ `active_to` (open-ended allowed); a credential outside
  its window cannot satisfy the routing rule.
- **Status** — `Active` / `Inactive` toggle.
- **Rotation date** — last-rotated timestamp + a deadline chip (rotation due) per the org's
  rotation cadence; sandbox/fixture creds rotate quarterly.

---

## Rotation Flow

- **Rotate** opens a write-only secret entry; on save the prior ciphertext is superseded
  (cryptographic shred via KMS-key-version rotation), the rotation date advances, and the action
  is audited (operation captured, value never captured).
- Rotation is a step-up-required action (every Trading Partner Admin write requires step-up auth
  via the `state_trading_partner_credential_admin` ABAC predicate).
- A rotation that leaves a still-routing channel without an active credential surfaces an impact
  warning in the right rail before commit.

---

## Right Rail — Help / Impact

- **Routes-here** — the claims/channel that depend on this credential (e.g., "all CCO claims for
  CareOregon members route through this `cco_clearinghouse` record").
- **Channel match** — confirms the credential's channel matches the M40
  the routing channel *(target — no `state_medicaid_mco` table exists; the channel vocabulary is the `m24_channel` enum)* so the `medicaid_mco_assignment_routes` rule resolves.
- **Rotation guidance** — cadence, last rotation, who rotated.

---

## Sensitivity & Guardrails

- `client_secret_cipher` / `sftp_key_cipher` are KMS-wrapped per-tenant; the UI shows masked
  values only; reads pass through `MedicaidTradingPartnerAdmin.upsertCredentials()` exclusively.
- Secrets never appear in logs, audit value-capture, or test fixtures.
- All identifiers render in IBM Plex Mono.
- Step-up auth gates create, rotate, activate, and deactivate.
- Optimistic concurrency: `If-Match` (version) on every PATCH; stale write → `412`.
- No AI surface (M24 AI block absolute).

---

## Empty State

"No trading partner credentials for this Provider Entity / state." → Add Credential.

---

## Actions

- Add Credential (PE · state · channel) — step-up
- Rotate secret — step-up
- Activate / Deactivate — step-up
- Set effective window
- View per-PE list (secrets masked)

---

## Pencil Notes

Create versions for:

- Settings sidebar (PE → State → Channel tree, status dots)
- Credential record — client_id full + client_secret masked
- Rotate-secret modal (write-only entry, step-up)
- Effective window + Active/Inactive toggle
- Rotation-due deadline chip + last-rotated
- Impact rail — routes-here + channel match
- Empty / add-credential state
- SFTP-key channel variant (sftp_key_cipher masked)
