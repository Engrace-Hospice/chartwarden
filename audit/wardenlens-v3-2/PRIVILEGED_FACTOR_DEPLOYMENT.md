# Privileged-factor deployment evidence

Status: PENDING. Nothing below has been verified against a production deployment. The branch is not merged until an
operator fills this in. `CHARTWARDEN_MFA_ENFORCEMENT` is read by the release already in production, so verify it there,
before merging.

Finding, 2026-11-25 (an operator ran the platform-staff query of OPS_RUNBOOK §16.5 on the production database and
supplied the result): the only platform-role holder is `orgadmin@chartwarden.local` (`platform_ops`, `platform_admin`).
No `superadmin` exists in production, so the `superadmin` results below are N/A until a grant is made as a separate,
ticketed change (step 8).

## Steps (run on the production host, in a quiet window, with one admin session left open)

0. **Go to the deploy directory on the host.** It is `/opt/chartwarden` unless the host overrode `DEPLOY_DIR`; it holds
   `compose.yml`, `deploy.sh` and `.env.production`. `docker compose ls` shows the real path of the running project.
   Every `docker compose` command below needs `--env-file .env.production -f compose.yml` (the image reference is
   required from that file), exactly as `deploy.sh` runs them.
1. **Enrol second factors first.** Every staff member registers a second factor, and every platform-role holder (today only `orgadmin@chartwarden.local`) registers a
   passkey, on the Passkeys page of the web app, today `https://wardenx.chartwarden.cloud` (`app.chartwarden.cloud` is only the planned
   rename target, `deploy/production/INFRA_RENAME_RUNBOOK.md`): sign in, then Settings (bottom of the left sidebar) and
   Passkeys, route `/security/passkeys` (the only enrolment path today; the admin console has no registration screen). A
   passkey is bound to the RP id (`PASSKEY_RP_ID`), so register on that host. Confirm
   first that the platform account can sign in there and reach it. If nobody can enrol a passkey, do not enable enforcement: it
   locks everyone out (`packages/auth/src/identity/mfa-policy.ts`).
2. **Turn it on.** In `/opt/chartwarden/.env.production`, add this line exactly. Only lowercase `true` enables it; `True`
   or `1` silently does nothing. Do not print or paste the rest of that file; it holds secrets:

   ```
   CHARTWARDEN_MFA_ENFORCEMENT=true
   ```

3. **Restart only the API so it reads the file:**

   ```sh
   cd /opt/chartwarden
   docker compose --env-file .env.production -f compose.yml up -d --no-deps --force-recreate api
   ```

4. **Verify the variable.** The api image is distroless (no `sh`, no `printenv`), so `exec` cannot run; read the container's
   configured environment instead. It must print `MFA enforcement enabled`, and it prints no other variable:

   ```sh
   docker inspect "$(docker compose --env-file .env.production -f compose.yml ps -q api)" \
     --format '{{range .Config.Env}}{{println .}}{{end}}' \
     | grep -qx 'CHARTWARDEN_MFA_ENFORCEMENT=true' && echo "MFA enforcement enabled"
   ```

5. **Check by hand, as the platform account** (`orgadmin@chartwarden.local`; no `superadmin` exists). A password-only
   sign-in must be refused, and a passkey sign-in must succeed.
6. **If anyone is locked out,** remove the variable (or set it to anything but `true`) and repeat step 3.
7. **Fill in the fields below,** commit this file, push, then tell Claude so it can update the CW-AC-45 gap text. The merge
   still needs an explicit go-ahead.
8. **Later, as its own change ticket:** grant `superadmin` (OPS_RUNBOOK §16.5) only after the variable result above is PASS.
   Then record that holder's passkey enrolment and a passkey-authenticated support-session start in a follow-up section
   here, before that holder reads any WardenLens evidence (Addendum 1 of the approval record).

Record only the deployment identifier, verification time, operator and sanitized output. Do not place credentials, cookies,
passkey material or PHI in this file.

- Deployment/release:
- Release/commit verified:
- Environment:
- Verified at:
- Verified by:
- `CHARTWARDEN_MFA_ENFORCEMENT=true`: PASS | FAIL
- Password-only sign-in was refused for the platform account: PASS | FAIL
- Platform-role holders in production (query, 2026-11-25): `orgadmin@chartwarden.local` (`platform_ops`, `platform_admin`); no `superadmin`
- All production `superadmin` holders have passkeys: N/A as of 2026-11-25, no holder (recorded at the `superadmin` grant)
- Passkey-authenticated support-session start succeeded: N/A as of 2026-11-25, no holder (recorded at the `superadmin` grant)
- Evidence-system/change-ticket reference:
