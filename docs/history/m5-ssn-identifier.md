# M5 SSN / state-id envelope writer, blind index and matcher feed (GAP-010)

## What was missing

`patient_identifier.value_encrypted` (bytea) existed with a CHECK that forbids a plaintext SSN, the permission keys
`phi.read_ssn` / `phi.write_ssn` existed, and the §2.3 matcher had a deterministic SSN + DOB rule. Nothing connected
them: `admit` threw `SSN_NOT_STORABLE`, `POST /identifiers` threw `SensitiveIdentifierUnsupportedError`, the matcher
loader hardcoded `ssn: null` (so rule 2 could never fire), and no role held either key.

## The construction

- **Envelope** (`05-patient/identifiers/identifier-cipher.ts`): `0x01 | verLen | dekVersion | nonce(12) | tag(16) | ct`,
  AES-256-GCM under the M34 per-tenant DEK, tag length pinned on decrypt. AAD =
  `wardenx:m5:patient_identifier:value_encrypted:v1:{org}:{identifierId}:{kind}` (row id, not patient id, so a merge
  repoint does not break decryption; kind so an ssn blob cannot be presented as a state_id). The key provider is
  injected structurally (M5 has no M34 edge), resolved lazily at the composition root.
- **Blind index** (`value_blind_index`): `HMAC-SHA256(HKDF-SHA256(ikm = DEK(v), info = "wardenx:m5:ssn-blind-index:v1:" + org), "ssn:" + nineDigits)`.
  It is keyed by a secret that is not in the database (a DB-only compromise or a restored backup cannot brute-force
  the 10^9 SSN space), and it derives from the DEK so the M34 cryptographic shred destroys it together with the
  ciphertext (a platform-wide index key would survive a shred). Per tenant. Inherent, accepted leak: inside one
  tenant equal SSNs have equal tokens; RLS scopes it and the audit trigger scrubs it. Never unique: two patients
  with the same SSN is the duplicate the matcher exists to find.
- **No re-seal worker needed for correctness.** Each row records `value_dek_version`. The matcher probe takes the
  distinct versions among open SSN rows (usually one), computes the token under each, and does
  `value_blind_index = ANY(tokens)`. It is correct after any number of rotations. A re-seal / re-index worker
  (the M18 `m18.dek-rotation` shape) would only retire old DEK versions; it is **not built** (owner decision).

## Behaviour

- Admit seals and indexes the SSN BEFORE the first insert: an unbound or destroyed key ring throws and the request is
  refused with `503 IDENTIFIER_CIPHER_UNBOUND`; no patient exists without the SSN it asked to keep. Admit without an
  SSN is unaffected.
- The SSN+DOB rule is fed from the index (`loadMatchCandidates(tx, ssnProbe)` stamps the incoming number on the hit
  candidates only); `matcher.ts` is untouched. A block returns (not throws) so the audit row
  `patient.create_blocked_ssn_dob` (denied, ids and rule name only) commits.
- `POST /patients/:id/identifiers` with `ssn` / `state_id` supersedes the open row and opens a soft
  `patient_match_review` (`rule: ssn_dob`) on a post-admit collision. `state_id` needs an issuing state and has no
  blind index.
- `POST /patients/:id/identifiers/:identifierId/reveal`: `phi.read_ssn` + chart scope + step-up; the audit event is
  written in the same transaction as the read.
- The audit trigger's scrub array is the control that keeps the columns out of `audit_event` (migration 0800);
  `valueEncrypted` / `valueBlindIndex` were also added to `packages/audit/src/denylist.ts` as defence in depth.
- The eraser's shred UPDATE also nulls the index and DEK version; the new CHECK allows the empty-bytea sentinel.

## Role grants (migration 0801, `packages/auth/src/roles/ssn-grants.ts`)

Write: `intake_supervisor`, `billing_manager`, `org_admin`, `administrator`. Read adds `compliance_officer`. The spec
names "Billing roles, Admissions Nurse, org_admin": `billing_finance` is a role CATEGORY (not a role key),
`billing_manager` is the M23 role, and there is no admissions-nurse key (clinical roles deliberately get neither key).

**Scope, as amended by ADR-0090.** Both keys declare `caseload_or_scope`. `compliance_officer`, `org_admin` and
`administrator` are org-wide-scope roles (`org-wide-scope.ts`), so their reveal and identifier POST reach every chart
in the org; for `intake_supervisor` and `billing_manager` they reach only charts the holder is assigned to (an
off-chart refusal is a 404). Admit-time SSN capture has no chart yet, so it needs only the permission + step-up.
(Before ADR-0090 `org_admin` and `administrator` were excluded from the org-wide list on purpose.)

## Not built / residual

- DEK re-seal worker (see above). Candidate loading is still whole-org for names/addresses.
- Merge does not carry identifiers to the survivor (GAP-084/085 scope).
- No per-user rate limiter on the reveal route (step-up + same-transaction audit + the global limiter apply).
- Web: the admit form SSN field and the identifiers-tab Reveal action are not built in this change.
- Operations: the tenant needs a bound platform KEK (`M34_TENANT_KEK`) and an active key ring; until then SSN
  capture answers 503 by design.
- Pre-existing, unrelated: `m5-patient-write-outbox.live` "amendment submit + decide" fails on the base branch
  (`A demographic amendment must name the field to change`).
