# Auditor link redemption and the M4 audit integrity sample (batch-11 deferrals)

Batch 11 (`41b296e2f`, GAP-011 / GAP-014) left two things explicitly unfinished. This closes them, with the
two named external gaps stated rather than papered over.

## 1. Auditor magic-link redemption (GAP-011 follow-up)

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

**Not built (named).** The spec's per-auditor **2FA enrolment and BAA acceptance** ceremony (M2 §7.7). A
passwordless external user has no enrolment surface (Better Auth's TOTP `enable` assumes a credential
account), and a step-up gate with no way to satisfy it would simply lock auditors out. The redeemed session
carries no step-up (`last_step_up_at IS NULL`), so every route that demands a fresh step-up stays closed to
an auditor, and the only thing it can reach is the one read permission above. The proof of identity is
possession of the single-use link delivered to the auditor's mailbox (the §4.1 "email verification precedes
session issuance" rule for collaborators).

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

## Verification

- `bun run test:m2:auditor-redemption:live` (11 tests, real Better Auth + authenticate hook + RBAC as
  `wardenx_app`) and `bun run test:m4:audit-integrity:live` (11 tests, a corrupted / inserted / deleted row and
  a tampered seal link are each detected; org B unaffected; destroyed month exempt).
- Unit: `m2-auditor-redemption.test.ts`, `packages/audit/__tests__/chain-sample.test.ts`, the enrolment
  delivery cases in `authz-routes.test.ts`, `auditor-redeem.dom.test.tsx`.
- Migrations: 0510 (`audit_integrity_run`), 0511 (permission mirror row).
