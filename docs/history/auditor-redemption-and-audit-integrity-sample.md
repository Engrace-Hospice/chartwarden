# Auditor link redemption and the M4 audit integrity sample (batch-11 deferrals)

Batch 11 (`41b296e2f`, GAP-011 / GAP-014) left two things explicitly unfinished. This closes them, with the
two named external gaps stated rather than papered over.

## 1. Auditor magic-link redemption (GAP-011 follow-up)

> Amended by section 3: redemption now yields an enrolment-stage session, and the least-privilege role is granted at
> activation (after the BAA terms and a second factor), not at redemption.

**What was missing.** M3's `POST /engagements/:id/auditors` minted a link through M2's `AuditorSessionMinter`
and then discarded the token: nothing emailed it, and nothing turned a consumed link into a session. The
durable `auditor_magic_link` store (migration 0402) could `consume` in SQL, but `consumeAuditorMagicLink`
had no caller.

**What exists now** (`apps/backend/src/modules/02-identity/auditor-redemption.ts`, route
`POST /api/v1/auditors/redeem`):

- **Delivery.** M3's enrolment route hands the token to an `AuditorLinkDeliveryPort`; production binds an
  M36-transport email whose link is `<web origin>/auditor/redeem?org=<id>#token=<token>`. The token is in the
  URL *fragment*, so it never reaches a server log or `Referer`. A delivery failure fails the enrolment
  (503 `AUDITOR_LINK_DELIVERY_FAILED`) and records nothing.
- **Redemption** is public (the token is the credential) and runs in one tenant-scoped transaction: lock the
  link row, constant-time digest comparison, classify (live / consumed / revoked / expired / not-yet-open),
  M3's pre-check (engagement still `active` and inside its window; the identity is not already a member), a
  single-use consume matched on row id *and* the live predicate with `RETURNING` asserted, mailbox
  verification, an `active` membership, M3's least-privilege grant, deletion of the user's other auditor
  sessions (no concurrent auditor sessions), and the session itself.
- **The session** is a Better Auth session minted through `internalAdapter.createSession` (so the GAP-001
  inactive-user refusal still runs) and signed exactly as Better Auth signs its cookie
  (`packages/auth/src/identity/auditor-session-issuer.ts`). `session_class = auditor`,
  `scope.engagementId`, `engagement_start/end`, `expires_at = engagement end`. It resolves through the
  ordinary `getSession` path with no auditor special case.
- **Least privilege.** One org-owned role, `external_auditor`, holding exactly
  `portal.engagement.read_auditor` (M31's engagement-scoped read), granted with `expires_at = engagement end`.
  If an admin has widened that role, redemption is refused (`AUDITOR_ROLE_MISCONFIGURED`), not trimmed. An
  email that already belongs to a staff member is refused (`AUDITOR_IDENTITY_IS_MEMBER`): the session
  resolves permissions from the membership, so reusing one would hand the auditor staff access. Migration
  0511 inserts the `permission` mirror row so the first grant cannot fail on the foreign key.
- **Read-only, enforced for every route.** The authenticate hook now refuses any non-GET/HEAD/OPTIONS request
  from an `auditor` session (`403 AUDITOR_READ_ONLY`), except sign-out and a second link redemption. The
  class descriptor's `readOnly` flag previously had no reader.
- **Audit.** `m2.auditor_link.redeemed` (under the auditor's own user id) and `m2.auditor_link.refused` (for
  every refusal of a *real* link, committed before the error is thrown). An unknown token is not audited, so
  an anonymous caller cannot flood the log. Rate limited per IP (20 / 15 min) and per organization
  (200 / 15 min) over the shared Valkey limiter.
- **Defect found on the way.** The M31 auditor engagement view's read-audit config had no `resourceIdParam`;
  the read event's resource id was empty, the audit insert failed on a uuid cast, and the failure was
  swallowed as best-effort. An auditor's use of their session left *no trail*. Fixed
  (`resourceIdParam: "engagementId"`), and the live suite asserts the event lands.
- **Why no Idempotency-Key.** The idempotency cache would have to replay a `Set-Cookie`, which it must not.
  The single-use token is the idempotency control: a replay is `409 LINK_ALREADY_USED`, never a second
  session; six concurrent redemptions yield exactly one.

**2FA enrolment and BAA acceptance (M2 §7.7) - built in batches-21, see section 3.** The first cut of
redemption authenticated by possession of the emailed link alone because a passwordless external user had no
enrolment surface and a step-up gate they could never satisfy would simply have locked them out. Section 3
adds that surface; the paragraph that used to sit here ("not built") is superseded.

**Related, unchanged.** `POST /collaborators/consume` (and funeral links) still do not mint a `session` row;
that is the same shape of gap for a different session class and was not part of this task.

## 2. M4 audit integrity sample (GAP-014 follow-up)

**What was missing.** The spec's quarterly `audit.integrity_sample` compares 100 live audit rows with a
pgBackRest backup. No backup reader exists in this repo, and the Phase-2 hash-chain seal (`audit_seal`,
`audit_hash_chain_enabled`, D2) had a pure library but no job, reader or run history.

**What exists now** (`apps/backend/src/modules/04-audit/jobs/audit-integrity-job.ts`, reader in
`packages/audit/src/integrity/`):

- **`audit.seal_partition`** (monthly) seals every closed UTC month (ended >= 24 h ago) per org: a sha-256
  chain over the month's rows in `(created_at, id)` order, linked to the previous seal. The row hash covers
  *every* tamper-relevant column, with `created_at` to the microsecond and `before/after/context` as
  `jsonb::text` (a JS `Date` or a re-serialised object would lose exactly what an attacker could change).
- **`audit.integrity_sample`** (quarterly) checks the `prev_chain_hash` link of *every* seal and fully
  recomputes a bounded random sample of sealed months (default 3, always including the newest;
  `AUDIT_INTEGRITY_SAMPLE_SIZE`). A flat chain hash cannot be checked from a handful of rows, so the sample
  is of seals, not rows.
- **Fail closed.** A mismatch commits an append-only `audit_integrity_run` row (migration 0510) with the
  broken partitions, writes an `audit.integrity_mismatch` critical audit event in the same transaction,
  raises the M36 alert `m4.audit.integrity_mismatch` (platform-default rule, Security Officer + Compliance
  Officer + org admin), and **throws** so the BullMQ job fails. If the alert transport is down the job still
  fails, after the evidence row is committed. A run that itself errors leaves an `error` row.
- **Gating.** Per org by the `audit_hash_chain_enabled` feature flag, **default off** (M4 D2 is a decided
  spec choice and was not overridden). A disabled org gets `skipped` rows; `GET /audit/integrity/report`
  omits `sealChain` until seals exist, so "never checked" never reads as "verified clean".
- **Report.** `GET /api/v1/audit/integrity/report` now returns `sealChain` (`contiguous`,
  `lastSealedPartition`, `brokenAt`) and a new `integritySample` section including
  `backupCrossReference: "unavailable_no_backup_reader"`.
- **Destroyed months.** A month covered by an `executed` / `partial_refused` audit destruction certificate is
  excluded from the recompute (the rows were legitimately erased); its seal link is still checked.

**Not built (named).** The **pgBackRest backup comparison**. It needs a restore/read path to the backup
(external infrastructure). Every run records the gap in `backup_cross_reference`; the seal chain is the
independent reference instead. The chain lives in the same database, so it detects tampering by anything that
cannot rewrite *both* the rows and the seals (the app role can do neither: `audit_event` and `audit_seal` are
append-only for it, asserted live); a superuser who edits both is outside what an in-database reference can
prove, which is what the off-host backup comparison is for.

**Enabling it.** Set the `audit_hash_chain_enabled` feature flag for the org (or platform default). The
monthly job seals the backlog on its first run; the next quarterly sample (or an ad-hoc run of the queue)
verifies it.

## 3. Auditor enrolment: BAA terms and a second factor (batches-21)

**State machine.** Redemption no longer produces a reading session. It mints an **enrolment-stage** session
(`session.scope.auditorStage = "enrolment"`, fail closed: anything but an explicit `active` reads as
`enrolment`). The authenticate hook lets that session call exactly five routes
(`/api/v1/auditors/enrolment/{state,baa,totp/begin,totp/confirm,verify}`) plus sign-out and a second
redemption, refuses everything else with `403 AUDITOR_ENROLMENT_REQUIRED`, and stamps no engagement read
scope. The `external_auditor` role is now granted at **activation**, not at redemption, so a half-enrolled
session holds no permission at all (the hook is one layer, the missing role the second). Activation happens
inside whichever enrolment call completes the last requirement: terms accepted for this engagement AND a second
factor proven in this session. It grants the role (M3 port, expiring with the window), flips the stage to
`active` and, when the factor was TOTP, stamps `last_step_up_at` / `last_step_up_factor = totp` (the spec's
step-up semantics). An `active` session is read-only exactly as before and can no longer call the enrolment
mutations.

**Second factor.** TOTP only (SMS never). The first engagement enrols: `totp/begin` writes an unconfirmed
`two_factor` row (the same row, double encryption and Better Auth primitives the staff step-up verifier reads -
`createOTP`, `generateRandomString`, `symmetricEncrypt`, the ADR-0034 seal), `totp/confirm` turns it real and
returns ten recovery codes **once**; later engagements (another engagement, or a re-issued link) must
**present** the factor - the enrolled factor is user-level and is never replaced through a link. Recovery
codes are 100-bit, shown once and stored as `[{ hash, usedAt }]` (HMAC-SHA256 keyed by the instance secret) in
`two_factor.backup_codes_encrypted`; a code is spendable exactly once under a row lock. A TOTP code is matched
to its 30-second step and the step is recorded in `last_used_at`, so a spent step cannot be replayed. Five
consecutive wrong codes lock the factor 15 minutes in the Better Auth lockout columns (`failed_verification_count`,
`locked_until`): 429 `AUDITOR_2FA_LOCKED` + `Retry-After`, and a correct code is refused while locked. Failures
are committed (audited) before the typed error is thrown. Per-IP and per-user attempt budgets sit in front.

**BAA / terms.** `auditor_baa_acceptance` (migration 0540, org-scoped RLS, **append-only** for the app role:
SELECT and INSERT only) records user, typed name, time, ip, user agent, session, engagement, the terms
**version** and the **sha-256 of the exact text shown**; the pair posted must match the terms in force (stale ->
409 `AUDITOR_TERMS_STALE`), re-posting is idempotent, and acceptance is per engagement. The text is the
platform-owned document in `auditor-terms.ts`. **M40 was reviewed and deliberately not reused**: its
`BaaStatusProvider` / `mdm_baa_record` answer "does this tenant hold an executed BAA with this master-data
entity" for PHI disclosures to physicians, facilities and payers; an audit agency is not an MDM entity and the
seam has no notion of an individual's acceptance or of terms text. The wording is an engineering draft and needs
legal approval (a unit test pins the hash to the version so the text cannot change silently).

**Audit.** `m2.auditor_enrolment.{baa_accepted, totp_started, totp_enrolled, factor_verified,
recovery_code_used, factor_failed, locked, refused, activated}`, all `compliance`, none carrying a code, secret
or recovery code (the live suite greps the trail for them). Every mutating step first re-checks with M3 that the
engagement is still live; a cancelled engagement refuses the step (audited, nothing recorded).

**Residual risks (named).** (1) First-engagement enrolment is trust-on-first-use of the emailed link: whoever
holds the link first enrols the authenticator; the control is the single-use, mailbox-bound link itself, and
every later engagement is protected by the factor. (2) There is no reset route for a lost factor with no
recovery codes - platform operations must clear the `two_factor` row out of band and the organization
re-issues the link. (3) The `two_factor` and `session` write triggers log whole rows to the audit trail (sealed
secret, recovery-code hashes, session scope) - the pre-existing ADR-0034 posture for those tables, not
introduced here. (4) Sessions minted before this change have no `auditorStage` and so read as `enrolment`: a
live auditor mid-engagement is asked to enrol on their next call (fail closed by design).

## Verification

- `bun run test:m2:auditor-redemption:live` (11 tests, real Better Auth + authenticate hook + RBAC as
  `wardenx_app`) and `bun run test:m4:audit-integrity:live` (11 tests, a corrupted / inserted / deleted row and
  a tampered seal link are each detected; org B unaffected; destroyed month exempt).
- Unit: `m2-auditor-redemption.test.ts`, `packages/audit/__tests__/chain-sample.test.ts`, the enrolment
  delivery cases in `authz-routes.test.ts`, `auditor-redeem.dom.test.tsx`.
- Migrations: 0510 (`audit_integrity_run`), 0511 (permission mirror row), 0540 (`auditor_baa_acceptance`).
- Enrolment (section 3): `bun run test:m2:auditor-enrolment:live` (9 tests as `wardenx_app`: enrolment-only
  session, BAA + TOTP upgrade in either order, hashed recovery codes, lockout and expiry, second redemption
  requires the factor + replay refusal, single-use recovery code, org isolation + append-only table, audit trail,
  cancelled engagement, 422/401/429); the redemption live suite now drives every read through a real enrolment.
  Unit: `m2-auditor-enrolment.test.ts`, `auditor-second-factor.test.ts`, the stage-gated hook cases in
  `m2-auditor-redemption.test.ts`, `auditor-enrolment.dom.test.tsx`.
