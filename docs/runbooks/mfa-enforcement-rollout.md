# Runbook: second-factor enforcement is the default (CW-AC-45, CW-AC-55)

**Audience:** the platform operator who deploys ChartWarden. **Read-only until you reach "Rollout order".** Nothing in
this runbook was run by an agent; every production step is the operator's.

## What changed in code

- The server-side second-factor matrix (`packages/auth/src/identity/mfa-policy.ts`) is **enforced by default** in every
  environment. Every staff role needs a second factor (an authenticator app or a passkey); `org_admin`, `platform_ops` and
  `superadmin` need a **passkey**. A tenant `administrator` needs a second factor, not specifically a passkey (the
  CW-AC-55 remainder: widening the passkey set to `administrator` is a separate decision).
- Only the exact value `CHARTWARDEN_MFA_ENFORCEMENT=false` relaxes it. A missing variable, `true`, `True`, `1` or a typo
  all leave it enforced.
- In production a relaxation also needs `CHARTWARDEN_MFA_RELAXATION_REASON` (12+ characters: the change ticket and why);
  without it the API refuses to boot (`collectEnvProblems`; `deploy.sh` runs `assertProductionEnv()` before it migrates).
  A relaxed boot logs a warning and writes one critical `m2.auth.mfa_enforcement_relaxed` audit row; if production cannot
  write that row it does not serve.
- A session held at the enrolment stage leaves `m2.auth.mfa_enrolment_refused` (sampled once per session, requirement
  and reason per five minutes; ids, enums and the route template only) in the tenant's own audit trail.
- The local Compose stack, `.env.example` and the e2e CI job set `CHARTWARDEN_MFA_ENFORCEMENT=false` explicitly, because
  their seeded staff sign in with a password only. Production's example file keeps `CHARTWARDEN_MFA_ENFORCEMENT=true`.

## The enrolment path (why an admin is not locked out)

A held session still reaches `/api/auth/*` and `/api/v1/auth/*`, so the person can register a passkey or an authenticator:

1. Sign in with the password. `select-organization` answers `403 MFA_ENROLMENT_REQUIRED` with the requirement in the message.
2. The web app links that refusal to the chromeless `/login/passkey` (apps/web `organization-select.tsx`), which registers a
   passkey without needing an organization. An already-bound session reaches `/security/passkeys` the same way.
3. Sign out and sign in again **with the passkey**. Enrolment alone is not enough: the session must have proven the factor
   (`session.last_step_up_factor`), so a passkey-only user on a password session is still held (`reason: not_verified`,
   message "sign in again with your passkey").

The console (`apps/admin`) has no registration screen; passkeys are registered on the web app. A passkey is bound to the
relying-party id, so `PASSKEY_RP_ID` / `WEBAUTHN_RP_ID` must cover every host the person signs in on (see
`audit/wardenlens-v3-2/PRIVILEGED_FACTOR_DEPLOYMENT.md`, step 1). Changing the id invalidates every passkey.

## Rollout order (production)

Production was found with `CHARTWARDEN_MFA_ENFORCEMENT=true` on 2026-11-25
(`audit/wardenlens-v3-2/PRIVILEGED_FACTOR_DEPLOYMENT.md`), so deploying this change alters nothing there **provided the
line is still `true` or absent**. Any other deployment (staging, a demo, a new environment) is enforced from this release
on, and must be walked through the list.

1. **Inventory first (read-only).** List every active membership that holds a live role and has neither a verified
   authenticator nor a passkey, and every holder of `org_admin`, `platform_ops` or `superadmin` without a passkey. Use the
   deployment's own reporting or this helper (it approximates the server's gate; the sign-in check in step 4 is the truth):

   ```sql
   -- Active staff with a live role and no second factor. Run as the database owner on the host; paste no results into tickets.
   SELECT u.email, m.organization_id, array_agg(DISTINCT r.key) AS role_keys,
          EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id AND t.verified) AS has_totp,
          EXISTS (SELECT 1 FROM passkey p WHERE p.user_id = u.id AND p.public_key IS NOT NULL) AS has_passkey
     FROM membership m
     JOIN "user" u ON u.id = m.user_id
     JOIN membership_role mr ON mr.membership_id = m.id
     JOIN role r ON r.id = mr.role_id AND r.enabled
    WHERE m.status = 'active'
    GROUP BY u.id, u.email, m.organization_id
   HAVING NOT (EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id AND t.verified)
               OR EXISTS (SELECT 1 FROM passkey p WHERE p.user_id = u.id AND p.public_key IS NOT NULL))
       OR (array_agg(DISTINCT r.key) && ARRAY['org_admin','platform_ops','superadmin']
           AND NOT EXISTS (SELECT 1 FROM passkey p WHERE p.user_id = u.id AND p.public_key IS NOT NULL));
   ```

2. **Enrol everyone on the list** through the path above, **one admin session left open** until step 5 is done. An
   `org_admin` or `platform_ops` holder needs a passkey on the host the person actually signs in on.
3. **Check the setting.** `grep -E '^CHARTWARDEN_MFA_(ENFORCEMENT|RELAXATION_REASON)=' .env.production` must show
   `CHARTWARDEN_MFA_ENFORCEMENT=true` or no such line, and no relaxation reason. Do not paste the file.
4. **Deploy** through the normal path (`deploy.sh`; it runs the environment check before migrating). Then, for each admin
   role, sign in once: a password-only session must be refused at organization selection, a passkey sign-in must succeed.
   Confirm the API logged no `MFA matrix is RELAXED` warning.
5. **Close the loop.** Record the verification in `audit/wardenlens-v3-2/PRIVILEGED_FACTOR_DEPLOYMENT.md` (or the successor
   record) and tell the register owner so the CW-AC-45 and CW-AC-55 rows can be reviewed.

## The production reseed stack signs in with a password only

`reseed-production.yml` and `deploy/production/reseed-demo.sh` start `seed-api` (it extends `api`, so it reads
`.env.production` and runs with `NODE_ENV=production`), and the seed runner signs seeded staff in with a **password only**
(`scripts/db/lib/api-session.ts`: sign-in, then `select-organization`). Seeded users hold no authenticator and no passkey, so
with the matrix enforced the runner is refused `403 MFA_ENROLMENT_REQUIRED` at `select-organization`. On the main host that was
already so once `CHARTWARDEN_MFA_ENFORCEMENT=true` was set on 2026-11-25; on a host that never set it, it starts with this
release. This change does not touch `compose.yml`: relaxing the reseed stack is the operator's decision, because in production
it needs `CHARTWARDEN_MFA_RELAXATION_REASON` and writes a critical `m2.auth.mfa_enforcement_relaxed` row on every reseed.
Do not reseed a deployment that holds real patient data (the reseed is a demo-data flow), and do not relax enforcement
there to make a reseed pass.

## Relaxing for a bounded window (rollback, or re-enrolment after an RP id change)

A held session cannot enrol anyone else, so a lock-out is recoverable only by relaxing, enrolling, then re-enforcing:

1. In `.env.production` set `CHARTWARDEN_MFA_ENFORCEMENT=false` **and** `CHARTWARDEN_MFA_RELAXATION_REASON=<ticket and why>`.
2. Recreate only the API (`docker compose --env-file .env.production -f compose.yml up -d --no-deps --force-recreate api`).
   The boot writes the critical `m2.auth.mfa_enforcement_relaxed` row; look for it in the platform audit trail.
3. Enrol the people who are locked out. Keep the window short: every staff session is unprotected by a second factor until it ends.
4. Remove both lines (or set `CHARTWARDEN_MFA_ENFORCEMENT=true`), recreate the API again and re-run step 4 above.

If the API refuses to boot after step 1, the message names `CHARTWARDEN_MFA_RELAXATION_REASON`: the reason is missing or
shorter than 12 characters. If it refuses with "the relaxation unaudited", the audit write failed; fix the database first,
because production will not serve a relaxation it cannot record.

## Evidence the change is live (CI and a private database, not production)

- `bun run test:m2:auth-hardening:live`: enforcement by the code default as `chartwarden_app`; a password-only clinician,
  an `org_admin` with only a TOTP, a platform-owned `superadmin` and a tenant `administrator` are held or admitted as the
  matrix says; every refusal writes one sampled org-scoped `m2.auth.mfa_enrolment_refused` row; an admitted request writes none.
- `bun run test:m22:part2-admin-factor:live`: the two Part 2 intake routes (workspace, page image) refuse an `org_admin`
  without a passkey before any content is read, with the refusal audited and no read event; with a passkey they return the
  content and the `<kind>.viewed` read event lands; a clinician, a live break-glass grant and an auditor session read no Part 2
  content.
