# Privileged-factor deployment evidence

Status: PENDING. Nothing below has been verified against a production deployment. The branch is not merged until an
operator fills this in. `CHARTWARDEN_MFA_ENFORCEMENT` is read by the release already in production, so verify it there,
before merging.

## Steps (run on the production host, in a quiet window, with one admin session left open)

1. **Enrol second factors first.** Every staff member registers a second factor, and every `superadmin` holder registers a
   passkey, on the passkey page of the web app (the only enrolment path today). Enforcement locks out anyone without a
   factor (`packages/auth/src/identity/mfa-policy.ts`).
2. **Turn it on.** In `deploy/production/.env.production` (the file next to `compose.yml`), add this line exactly. Only
   lowercase `true` enables it; `True` or `1` silently does nothing:

   ```
   CHARTWARDEN_MFA_ENFORCEMENT=true
   ```

3. **Restart the API so it reads the file:**

   ```sh
   cd deploy/production
   docker compose up -d --force-recreate api
   ```

4. **Verify the variable.** It must print `MFA enforcement enabled`:

   ```sh
   docker compose exec -T api sh -lc \
     'test "$CHARTWARDEN_MFA_ENFORCEMENT" = "true" && echo "MFA enforcement enabled"'
   ```

5. **Check by hand, as a `superadmin`.** A password-only sign-in must be refused. A passkey sign-in must then start a
   support session successfully.
6. **If anyone is locked out,** remove the variable (or set it to anything but `true`) and repeat step 3.
7. **Fill in the fields below,** commit this file, push, then tell Claude so it can update the CW-AC-45 gap text. The merge
   still needs an explicit go-ahead.

Record only the deployment identifier, verification time, operator and sanitized output. Do not place credentials, cookies,
passkey material or PHI in this file.

- Deployment/release:
- Release/commit verified:
- Environment:
- Verified at:
- Verified by:
- `CHARTWARDEN_MFA_ENFORCEMENT=true`: PASS | FAIL
- All production `superadmin` holders have passkeys: PASS | FAIL
- Password-only privileged authentication was refused: PASS | FAIL
- Passkey-authenticated support-session start succeeded: PASS | FAIL
- Evidence-system/change-ticket reference:
