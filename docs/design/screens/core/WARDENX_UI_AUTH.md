# WARDENX_UI_AUTH

Version: 1.0
Status: Screen Specification
Module: Authentication & Session (M02)

---

## Purpose

The Authentication surface covers every pre-application identity flow: sign-in, MFA
challenge, organization selection, password reset, invitation acceptance, the idle
screen-lock, and the step-up challenge. It is the front door for all four session classes
(staff, auditor, external collaborator, funeral home).

---

## Primary Users

- Staff (all clinical and administrative roles)
- Auditor (engagement magic-link)
- External Collaborator (per-patient magic-link)
- Funeral Home (post-death magic-link)

---

## Layout Pattern

Use Auth Flow.

```text
Centered Card
  Brand / Context
  Step Content (single focused action)
  Primary Action
  Secondary / Recovery Links
```

---

## Flows

- **Sign in** (`/login`) — email + password, or passkey. Returns an MFA challenge if enrolled.
- **MFA challenge** (`/login/2fa`) — TOTP 6-digit or backup code; SMS only as an
  accessibility fallback.
- **Organization select** (`/login/organization`) — multi-org users pick an org; the choice
  binds the session (one-time).
- **Password reset** (`/forgot`, `/reset-password`) — request → confirm; token TTL 15 minutes.
- **Accept invitation** (`/invite/:token`) — validate token → set password (live policy
  meter) → verify email → enroll mandatory MFA (TOTP or passkey per role) → land in org.
- **Screen-lock overlay** — after 5 minutes idle; soft re-auth (password / biometric /
  passkey); session stays alive until absolute timeout.
- **Step-up challenge** (full-page chrome-less route `/step-up` — deliberately outside the app shell, not a modal) — triggered by privileged actions; WebAuthn or TOTP only
  (**never** SMS); a successful login seeds a 5-minute step-up window.

---

## MFA Factors

`TOTP` (required for clinical/admin roles), `SMS` (accessibility fallback; never qualifies as
step-up), `Passkey` (required for `org_admin` / `platform_ops`).

---

## Statuses

- User: `Invited`, `Active`, `Suspended`, `Deactivated`.
- Membership: `Pending`, `Active`, `Suspended`, `Revoked`.
- Invitation: `Pending`, `Accepted`, `Expired`, `Revoked`.

---

## Session & Security Rules

- Session classes carry distinct timeouts (staff: 15-min idle / 8h work / 24h absolute;
  auditor: 10-min idle, no concurrency; external/funeral: bounded magic-link windows).
- Lockout after 3 failed attempts within 60 seconds (tenant may tighten to 2).
- **No in-session org switch** — switching organizations signs out and back in.
- Impersonation is disabled; support access is the audited Support / Impersonation flow.

---

## Accessibility

First-class (the population includes low-vision and assistive-tech users): WCAG 2.2 AA,
full keyboard path, visible focus, screen-reader labels on every field, no time-only
challenges without an accessible fallback.

---

## Error / Edge States

- Invalid or expired token (reset / invite) → re-request path.
- MFA locked out → recovery guidance.
- Membership suspended/revoked at login → contact-admin message (no PHI).

---

## Actions

- Sign in · Sign in with passkey
- Verify MFA · Use backup code
- Select organization
- Request / confirm password reset
- Accept invitation · enroll MFA
- Re-authenticate (screen-lock / step-up)

---

## Pencil Notes

Create versions for:

- Sign in (password vs passkey)
- MFA challenge (TOTP / backup / SMS fallback)
- Organization select (multi-org)
- Accept invitation (multi-step)
- Screen-lock overlay
- Step-up modal
