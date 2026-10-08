# Portal invitee sign-in and funeral / collaborator link redemption

> Closes two deferrals left by the GAP-092 / GAP-115 batches: (1) a portal invitation could be issued and accepted
> (GAP-092, GAP-158) but the invitee could not **sign in**; (2) `POST /api/v1/funeral/invite` minted a link that nobody
> could **redeem** (M2 spec "Implementation status (GAP-115)", blocked item 2). Migrations **0520** and **0521**.

## 1. Portal invitee sign-in

**Who owns what.** M2 owns authentication (ADR-0026: Better Auth is the single surface). The spec leaves the factor open
after setup ("magic link, then password + TOTP or passkey") and `sign-in.tsx` already named the link as primary, so no
new factor was invented: the invitee signs in with the **same single-use emailed magic-link primitive the auditor and
CAHPS links use** (Better Auth `magicLink`, GAP-009 `disableSignUp` in production so it signs an existing user in and
never mints one), or with password + authenticator code. Whatever they used, the result is a **pre-org session** (a user,
no organization). M31 owns the account binding. What was missing was the bind and, behind it, RBAC:

- **The bind** — `GET /api/v1/portal/sign-in/accounts` and `POST /api/v1/portal/sign-in/establish`
  (`31-portal/routes/sign-in.routes.ts`, pure decision in `31-portal/sign-in/index.ts`). The signed-in user's *own* portal
  accounts are read through a narrow `SECURITY DEFINER` function (`m31_list_own_portal_accounts`, migration **0520**, role
  `portal_signin_reader`, the `m2_list_own_memberships` shape — `app.user_id` is not made an RLS variable, ADR-0010 D2).
  It returns tenant display name, relationship, status, live-grant counts and email-verified; no contact PHI, no patient id.
  The bind is **one conditional UPDATE** of the `session` row (organization + `session_class` + `scope.portalAccountId`
  together, matched on id **and** user **and** "still pre-org staff", RETURNING asserted — `02-identity/portal-sign-in-store.ts`),
  so `session_scope_chk` holds at every instant and a session already bound as anything cannot be re-scoped by this path
  (a replay of the identical bind answers 200 `replayed:true`; a different bind is a 409).
- **Eligibility, all fail-closed, each with its own typed reason** (the caller is already authenticated and is only being
  told about their own accounts): account `active`/`bereaved` (an `invited` account must accept the invitation first;
  `suspended`/`revoked` is the lockout), tenant `active`, user not suspended, **email verified** (the magic link verifies
  it; a password sign-up that never proved its address is refused), at least one **live grant**. Several eligible accounts
  answer 409 until one is named; naming an account the user does not hold is indistinguishable from naming none.
  Class: `patient_self` -> `patient_portal`, any delegate -> `caregiver_portal`, bereaved account or all-bereaved grants
  -> `bereaved_portal`.
- **Scoped to the patients the account is granted.** `select-patient` already refuses a patient with no live grant; new
  `GET /api/v1/portal/sessions/patients` lists the account's live grants for the picker (D2).
- **Rate limiting, lockout, audit.** The global per-user tier applies; failed binds are throttled per user + per IP with
  the §5.3.1 shape (`createCredentialThrottle` gained a `keyPrefix`, so this door has its own budget): the 6th refusal is
  429 + `Retry-After`. Every bind and every refusal where the tenant is known is audited
  (`m2.portal.session_established` / `.session_refused`). No PHI is read or returned before the bind.
- **RBAC for portal sessions (a gap the sign-in exposed).** Nothing ever granted a portal session its `portal.*` keys: the
  effective-permission resolver answers from `membership_role`, a portal user has none, and the spec's default roles
  (`portal_caregiver`...) were never seeded — every real portal route would have 403'd after a perfect sign-in. Permissions
  are now a property of the server-bound **session class** (`packages/auth/src/rbac/session-class-permissions.ts`, an
  explicit allow-list; installed by `registerDbEffectivePermissionResolver`). A portal session gets *only* its class set —
  a clinician who also has a portal account carries no clinical key into a portal session (live-proven), and the staff-only
  `portal.invitation.*` / `portal.account.*` / `telehealth.*` keys are never granted. Per-patient narrowing stays where it
  was: the §4.7 ABAC predicates read account and patient from the session.
- **UI** — `apps/portal`: `sign-in.tsx` (link primary; password + code; no passkey button — see below), new `signed-in.tsx`
  (`/signed-in`: binds, chooses between several accounts, plain-language refusals), `patient-picker.tsx` lists the grants.

**Not built / blocked.**
- **Production email.** (Adapter now built: see [`m36-transactional-email-provider.md`](./m36-transactional-email-provider.md); only the operator steps remain.) M36's `selectTransactionalEmailTransport` has no provider bound (Postmark/SES adapter), so in
  production the magic-link email is **dropped**. Password + TOTP works; the link works in dev (console transport).
  Binding the provider is the single remaining step (also unblocks item 2).
- **Passkey sign-in** from the portal (WebAuthn needs the auth client bundle); passkeys remain enrol/use via the account page
  once built. Nothing on the sign-in screen pretends otherwise.
- DPOA agents are `caregiver_portal`, so they do **not** hold `portal.amendment.*` (the spec lists them); the amendment route
  has no grant-kind branch and a class cannot tell a DPOA agent from a family caregiver. Giving it to every caregiver would
  be worse. Needs a kind-aware check (or a DPOA class).
- `POST /api/v1/portal/sessions/logout` still only acknowledges (the SPA calls Better Auth's `/api/auth/sign-out`).

## 2. Funeral-home / collaborator link redemption

Links are issued by M2 (`POST /api/v1/funeral/invite`, `/collaborators/invite`; M16 explicitly delegates the funeral
magic link to M2 — bereaved *family* sign in through item 1). The store was a per-process `Map` and consume never created a
session.

- **Durable store** — `collaborator_link` (migration **0521**, M2-owned, RLS + audit trigger, ARCH-011 columns resolved
  from the patient's admission): **sha256 only** at rest (`token_hash` unique), token = `<orgId>.<256-bit secret>`, bounded
  use (`max_uses`, default 1) claimed in **one conditional UPDATE** on the database clock (not revoked, not expired,
  `use_count < max_uses`), `timingSafeEqual` on the returned digest, org named in the WHERE under RLS. Unknown, malformed,
  cross-tenant, expired, spent and revoked all answer the same typed 410/409; only the audit (known links) learns why.
- **A real session** — a server-only Better Auth endpoint (`createAuthEndpoint.serverOnly`, never on the HTTP router;
  `packages/auth/src/identity/link-session.ts`) creates the `session` row (class, org, `scope.patientId`, expiry — passed
  with `overrideAll`, because Better Auth otherwise lets the `session_class` default `staff` win) and the signed cookie.
  `session.user_id` is NOT NULL, so the first redemption creates a **credential-less synthetic principal**
  (`link-<id>@principals.wardenx.invalid`: no password, no account row, no membership — it can authenticate only through
  its link; live-proven). One active session per link.
- **Minimum scoped read** — `GET /api/v1/funeral/case` returns legal name + date of death of the pinned decedent and nothing
  else (M5 `funeralCaseForOrg`), behind `funeral.case_read` (a *class* permission: no role carries it) and the new
  `funeral_session_pinned_patient` predicate; audited (`funeral_case` read, joined to the patient).
- **Fail closed everywhere** — eligibility is re-proved at redemption (a patient no longer deceased => 410 and the use is
  **handed back**); a failing session mint hands the use back too (a transient fault never burns a one-time link); issuance
  requires `recipientEmail` and a bound delivery port and refuses 503 `LINK_DELIVERY_UNAVAILABLE` **before minting**; a send
  that fails after minting revokes the link. The token travels in the URL **fragment** (`/funeral/redeem#token=`), is never
  in a response body, log, audit or outbox row (live-asserted by scanning the tables for the secret). Failed redemptions are
  throttled per IP (429 + `Retry-After`).
- **UI** — `apps/portal`: `/funeral/redeem` (reads and clears the fragment, POSTs once), `/collaborator/redeem`, `/funeral/case`.

**Blocked externally.** The production email provider (above). `transactionalEmailProviderBound` (now derived from the Postmark adapter being bound) keeps the delivery port **unbound in production while unconfigured**, so funeral/collaborator invites answer 503 there until a provider is
bound; dev/test deliver via the console transport. The external-collaborator session has no read surface yet (no
collaborator permission exists), so `/collaborator/redeem` only confirms the session.

Proof: `m31-portal-signin.live.test.ts` and `m2-link-redemption.live.test.ts` (real Better Auth over HTTP as the
NOBYPASSRLS `wardenx_app`, real catalog-validating outbox publisher), plus unit suites for the decision, the class
permission sets, the token/hash helpers, the delivery URL and the redemption route's fail-closed branches.
