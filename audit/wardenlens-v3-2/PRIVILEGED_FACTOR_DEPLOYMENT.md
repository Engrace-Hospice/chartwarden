# Privileged-factor deployment evidence

Status: PENDING. Nothing below has been verified against a production deployment. The branch is not merged until an
operator fills this in. `CHARTWARDEN_MFA_ENFORCEMENT` is read by the release already in production, so verify it there,
before merging.

Findings, 2026-11-25 (an operator ran the read-only checks below on the production host and supplied the results):

- The only platform-role holder is `orgadmin@chartwarden.local` (`platform_ops`, `platform_admin`; OPS_RUNBOOK §16.5 query).
  No `superadmin` exists in production, so the `superadmin` results below are N/A until a grant is made as a separate,
  ticketed change (step 10).
- `PASSKEY_RP_ID` and `WEBAUTHN_RP_ID` were `wardenx.chartwarden.cloud`; `TENANT_BASE_DOMAIN` is unset. A passkey is bound to
  that id, and a browser only accepts an id that is the page's host or a parent of it, so a passkey registered on the web app
  cannot be used on the console (`platform112026.chartwarden.cloud`; `TRUSTED_ORIGINS` already lists it). Browser behaviour was
  not tested; it follows from the WebAuthn rule and `deploy/production/INFRA_RENAME_RUNBOOK.md`.
- Two passkeys existed, `admin@chartwarden.local` (2026-11-10) and `orgadmin@chartwarden.local` (2026-11-11), neither ever used
  (no `last_used_at`).
- `CHARTWARDEN_MFA_ENFORCEMENT` was already `true` in `.env.production` and in the running api container when checked on
  2026-11-25 (after the `PASSKEY_RP_ID` change), so the first sign-in afterwards was held with "sign in again with your passkey
  before continuing" and the old passkeys, bound to the old RP id, could not satisfy it. Steps 1 to 3 therefore need it OFF.
- With enforcement on, a staff session must have PROVEN its factor at sign-in, not merely have one enrolled
  (`apps/backend/src/modules/02-identity/mfa-enrolment-gate.ts`). The console signs in by password and proves a passkey on its
  `/step-up` page, which needs the RP id to cover the console host. Hence steps 1 to 3 come before enforcement.

## Steps (run on the production host, in a quiet window, with one admin session left open)

0. **Go to the deploy directory on the host.** It is `/opt/chartwarden` unless the host overrode `DEPLOY_DIR`; it holds
   `compose.yml`, `deploy.sh` and `.env.production`. `docker compose ls` shows the real path of the running project.
   Every `docker compose` command below needs `--env-file .env.production -f compose.yml` (the image reference is
   required from that file), exactly as `deploy.sh` runs them. Do not print or paste `.env.production`; it holds secrets.
   Before step 1, read the current state: `grep -E '^CHARTWARDEN_MFA_ENFORCEMENT=' .env.production` and the `docker inspect`
   check of step 6. If it is already `true`, set the line to `false` and recreate `api` (the command of step 5), because a
   held session cannot enrol a passkey.
1. **Make one passkey valid on the web app and the console.** Edit the two existing lines in place (do not append), then
   recreate only the API:

   ```sh
   cd /opt/chartwarden
   sed -i -E 's/^(PASSKEY_RP_ID|WEBAUTHN_RP_ID)=.*/\1=chartwarden.cloud/' .env.production
   docker compose --env-file .env.production -f compose.yml up -d --no-deps --force-recreate api
   docker inspect "$(docker compose --env-file .env.production -f compose.yml ps -q api)" \
     --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(PASSKEY_RP_ID|WEBAUTHN_RP_ID)='
   ```

   Both lines must read `chartwarden.cloud`. The trade-off: that passkey scope covers every `chartwarden.cloud` subdomain, and
   changing it again invalidates every passkey. To roll back, set both lines to `wardenx.chartwarden.cloud` and recreate `api`.
2. **Re-enrol on the web app, `https://wardenx.chartwarden.cloud`** (`app.chartwarden.cloud` is only the planned rename
   target). Passkeys registered under the old id no longer work, so for each of `admin@chartwarden.local`,
   `orgadmin@chartwarden.local` and every staff member who still signs in: sign in, then Settings (bottom of the left sidebar)
   and Passkeys (`/security/passkeys`, the only enrolment path; the console has no registration screen), delete the old
   entry, register a new passkey, sign out, then sign in with the passkey. If nobody can enrol, do not enable enforcement:
   it locks everyone out (`packages/auth/src/identity/mfa-policy.ts`).
3. **Prove it on the console, `https://platform112026.chartwarden.cloud`,** with enforcement still off: sign in with the
   password, open `/step-up` and complete the passkey. It must succeed. If it fails, stop; do not go on to step 4.
4. **Turn enforcement on.** Set the line to exactly this (change an existing `false`, do not add a second line). Only
   lowercase `true` enables it; `True` or `1` silently does nothing:

   ```
   CHARTWARDEN_MFA_ENFORCEMENT=true
   ```

5. **Restart only the API so it reads the file** (same `up -d --no-deps --force-recreate api` command as step 1).
6. **Verify the variable.** The api image is distroless (no `sh`, no `printenv`), so `exec` cannot run; read the container's
   configured environment instead. It must print `MFA enforcement enabled`, and it prints no other variable:

   ```sh
   docker inspect "$(docker compose --env-file .env.production -f compose.yml ps -q api)" \
     --format '{{range .Config.Env}}{{println .}}{{end}}' \
     | grep -qx 'CHARTWARDEN_MFA_ENFORCEMENT=true' && echo "MFA enforcement enabled"
   ```

7. **Check by hand, as the platform account** (`orgadmin@chartwarden.local`; no `superadmin` exists): a password-only
   session must be refused at organization selection (`403 MFA_ENROLMENT_REQUIRED`); a passkey sign-in on the web app must
   succeed; on the console, password sign-in followed by the `/step-up` passkey must reach the console.
8. **If anyone is locked out,** remove the `CHARTWARDEN_MFA_ENFORCEMENT` line (or set it to anything but `true`) and repeat
   step 5.
9. **Fill in the fields below,** commit this file, push, then tell Claude so it can update the CW-AC-45 gap text. The merge
   still needs an explicit go-ahead.
10. **Later, as its own change ticket:** grant `superadmin` (OPS_RUNBOOK §16.5) only after the variable result above is PASS.
    Then record that holder's passkey enrolment and a passkey-authenticated support-session start in a follow-up section
    here, before that holder reads any WardenLens evidence (Addendum 1 of the approval record).

Record only the deployment identifier, verification time, operator and sanitized output. Do not place credentials, cookies,
passkey material or PHI in this file.

- Deployment/release: api and worker `ghcr.io/engrace-hospice/chartwarden@sha256:329680cdf1a6d9ac24aee07a1df6daea5fbb29a611a456405ca772ad456e8ca7`; web `ghcr.io/engrace-hospice/chartwarden-web@sha256:48682108bf989feec4d8286b089085d6a67ade2a882fe2d7be9a5cbdb8fea000`
- Release/commit verified: `3efb7fbba` (main, merge of #1114; both images carry the tag `sha-3efb7fbba28f3cdf7555d0ab4de7e1f6b54fda03`). PR #1112 is not in this release.
- Environment: production, host `wardenx` (`/opt/chartwarden`)
- Verified at: RP id 2026-11-25T10:06Z; enforcement variable 2026-11-25T10:17Z (container recreated 10:17:42Z); browser checks below not yet reported
- Verified by: Fabrice Adjam (ran the production commands and supplied their output; the browser checks below are not yet reported)
- `PASSKEY_RP_ID` and `WEBAUTHN_RP_ID` read `chartwarden.cloud` in the running api: PASS (operator output, `docker inspect` on the recreated container, 2026-11-25T10:06Z)
- Passkey sign-in on the web app succeeded for the platform account: PASS | FAIL
- Passkey step-up on the console succeeded (enforcement off): PASS | FAIL
- `CHARTWARDEN_MFA_ENFORCEMENT=true`: PASS (operator output `MFA enforcement enabled` from the `docker inspect` check of the recreated api container, 2026-11-25T10:17Z)
- Password-only session was refused for the platform account: PASS | FAIL
- Platform-role holders in production (query, 2026-11-25): `orgadmin@chartwarden.local` (`platform_ops`, `platform_admin`); no `superadmin`
- All production `superadmin` holders have passkeys: N/A as of 2026-11-25, no holder (recorded at the `superadmin` grant)
- Passkey-authenticated support-session start succeeded: N/A as of 2026-11-25, no holder (recorded at the `superadmin` grant)
- Evidence-system/change-ticket reference:
