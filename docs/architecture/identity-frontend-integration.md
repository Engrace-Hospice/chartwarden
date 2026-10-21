# Identity frontend integration

Status: implemented against the generated ChartWarden API client and Better Auth client in the current
worktree.

## Authentication continuation

Password sign-in uses Better Auth directly. Email-shaped identifiers call `signIn.email`; all other
valid identifiers call `signIn.username`. A `twoFactorRedirect` always goes to the existing TOTP/
backup-code screen. Only after Better Auth has completed any MFA challenge does the web app read
`GET /api/v1/auth/credential-status`.

- `passwordChangeRequired: true` routes to `/login/change-password`.
- Otherwise the user continues to `/login/organization`.
- A credential-state read failure blocks continuation; it never defaults to workspace access.

The chromed application is wrapped by the M2-owned `CredentialStateGuard`, injected into the M1
shell at the composition root. This is an additional UX control. The backend credential-state gate
remains the authoritative protection.

The required-change screen calls
`POST /api/v1/auth/password/complete-required-change`. On success the backend has revoked all user
sessions, so the browser discards any remaining Better Auth state and requires a fresh full sign-in.

## Administrative user management

The Users screen uses the selected organization from the authenticated shell session. It never
accepts an administrator-entered organization id. Direct provisioning calls
`POST /api/v1/orgs/{orgId}/users`; tenant password reset calls
`POST /api/v1/orgs/{orgId}/users/{userId}/password-reset`.

The UI derives capabilities from effective permission keys, not role names:

- Create User: `user.create` and `role.assign`.
- Invite User: `member.invite`.
- Edit Roles: `role.assign`.
- Reset Password: `user.password.reset`.
- Membership lifecycle: `member.manage`.

Role choices are further bounded to enabled roles whose permission set is within the current
actor's effective permission set. The M3 server-side assignment ceiling remains authoritative.

Server-generated temporary passwords are held only in component memory, displayed once, never
automatically copied, and cleared when the dialog closes or the organization context changes.
Plaintext credentials are never written to browser storage or URLs.

## Known contract gaps

1. The backend does not expose a dedicated same-session screen-lock reauthentication operation.
   The existing screen lock uses Better Auth password sign-in and now supports either the captured
   email or username and verifies that the resulting user id is unchanged. A user whose password
   reauthentication triggers MFA must sign out and complete the full sign-in flow; the lock overlay
   cannot safely treat a partial MFA challenge as an unlock. A future backend endpoint should verify
   a factor against the current session without minting or switching sessions.
2. The roster contract does not expose `passwordChangedAt`, so the Security panel omits last password
   rotation rather than fabricating it.
3. New tenant permission keys are honored exactly as returned by `/api/v1/auth/context`. Migration
   `1066_m3_identity_admin_default_grants.sql` additively grants `user.create` and
   `user.password.reset` to existing `org_admin` and `administrator` roles; fresh tenants already
   receive both through full-catalog role materialization. Other roles remain tenant-configurable.
4. A tenant reset of a shared global identity is rejected with
   `SHARED_IDENTITY_RESET_RESTRICTED`. The UI gives a non-enumerating platform-administrator message
   and does not expose other organization details.
