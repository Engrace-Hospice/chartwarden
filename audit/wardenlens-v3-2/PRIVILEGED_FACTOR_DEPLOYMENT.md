# Privileged-factor deployment evidence

Status: PENDING. Nothing below has been verified against a production deployment. An operator fills this in after setting
`CHARTWARDEN_MFA_ENFORCEMENT=true` in the real production environment and running the check in `deploy/production`:

```sh
cd deploy/production
docker compose exec -T api sh -lc \
  'test "$CHARTWARDEN_MFA_ENFORCEMENT" = "true" && echo "MFA enforcement enabled"'
```

Record only the deployment identifier, verification time, operator and sanitized output. Do not place credentials, cookies,
passkey material or PHI in this file.

- Deployment/release:
- Commit: 707874893
- Environment:
- Verified at:
- Verified by:
- `CHARTWARDEN_MFA_ENFORCEMENT=true`: PASS | FAIL
- All production `superadmin` holders have passkeys: PASS | FAIL
- Password-only privileged authentication was refused: PASS | FAIL
- Passkey-authenticated support-session start succeeded: PASS | FAIL
- Evidence-system/change-ticket reference:
