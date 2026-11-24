# Privileged-factor deployment evidence

Status: PENDING. Nothing below has been verified against a production deployment. The branch is not merged until an
operator fills this in. `CHARTWARDEN_MFA_ENFORCEMENT` is read by the release already in production, so verify it there,
before merging.

Before setting it, enrol every staff member's second factor: enforcement locks out anyone without one
(`packages/auth/src/identity/mfa-policy.ts`). Rollback: remove the variable (or set it to anything but `true`) and recreate
the `api` container.

Set `CHARTWARDEN_MFA_ENFORCEMENT=true` in the real production environment, then run the check in `deploy/production`:

```sh
cd deploy/production
docker compose exec -T api sh -lc \
  'test "$CHARTWARDEN_MFA_ENFORCEMENT" = "true" && echo "MFA enforcement enabled"'
```

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
