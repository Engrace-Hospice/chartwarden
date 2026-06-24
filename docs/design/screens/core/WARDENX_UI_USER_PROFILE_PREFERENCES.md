# WARDENX_UI_USER_PROFILE_PREFERENCES

Version: 1.0
Status: Screen Specification
Module: User Profile & Preferences (M02 / M36 / M17)

---

## Purpose

The self-service settings surface for the signed-in user: profile, account security, notification
preferences, availability, and active sessions/devices. Preferences are self-only — no admin
override path.

---

## Primary Users

All staff (managing their own account).

---

## Layout Pattern

Use Admin Settings Layout.

```text
Settings Sidebar (categories)  |  Settings Content  |  Right: Help / Impact Notes
```

---

## Categories

### Profile
Display name, discipline, signature setup, preferred language, contact details.

### Security
- Password (live policy meter).
- MFA: enroll TOTP (QR + secret + backup codes); SMS only as accessibility fallback.
- Passkeys: register, label, last-used, remove.
- Step-up factors (WebAuthn / TOTP).

> Roles that require a factor (e.g. `org_admin` / `platform_ops` → passkey) cannot disable it.

### Notifications
Per-category × severity channel routing (in-app / push / SMS / email), quiet hours with a
severity override floor (critical always breaks through), vacation forwarding (bounded).

### Availability (scheduling)
Weekly availability windows, default start/end location, time-off requests
(`PTO` / `sick` / `bereavement` / `training` / `other`) with approval state `Requested` /
`Approved` / `Denied`.

### Sessions & Devices
Active sessions (device, IP, session class, last active) with revoke; registered mobile
devices (status `Pending Approval` / `Approved` / `Suspended` / `Retired`).

---

## Statuses

- MFA factors: `TOTP`, `SMS` (fallback), `Passkey`.
- Time-off: `Requested`, `Approved`, `Denied`.
- Device: `Pending Approval`, `Approved`, `Suspended`, `Retired`.

---

## Empty State

- No passkeys: prompt to add one.
- No availability set: "Set your weekly availability so you can be scheduled."

---

## Actions

- Edit profile · update signature
- Change password · enroll / disable MFA · add / remove passkey
- Set notification preferences · quiet hours · vacation forwarding
- Set availability · request time off
- Revoke session · manage devices

---

## Pencil Notes

Create versions for:

- Profile
- Security (MFA enroll + passkeys)
- Notification preferences (routing + quiet hours)
- Availability + time off
- Sessions & devices
