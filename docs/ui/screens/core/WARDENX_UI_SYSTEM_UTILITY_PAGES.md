# WARDENX_UI_SYSTEM_UTILITY_PAGES

Version: 1.0
Status: Screen Specification
Module: System / Utility Pages (cross-cutting)

---

## Purpose

The standardized status and error pages every application needs: a consistent, calm, PHI-free
way to tell the user what happened and what to do next. One pattern, several states.

---

## Primary Users

All users — including unauthenticated visitors and users who have lost access.

---

## Layout Pattern

Use System Page.

```text
Centered Status
  Icon / Illustration
  Headline (plain, non-technical)
  Explanation (no PHI, no stack traces)
  Primary Action  [ Secondary Action ]
  [ Reference / correlation id ]
```

---

## Pages

- **403 Forbidden** — "You don't have access to this." → Go Home / Request Access.
- **404 Not Found** — "We couldn't find that." → Go Home / Search.
- **500 / Unexpected Error** — "Something went wrong." → Retry / Go Home; show correlation id.
- **Offline** — "You're offline." → Retry; note which actions are queued (mobile).
- **Maintenance** — "WardenX is undergoing maintenance." → status link / ETA.
- **Session Expired** — "Your session ended." → Sign In (hands off to Auth).
- **Tenant Suspended / No Access** — "This organization's access is unavailable." →
  Contact admin (no PHI).
- **Degraded Mode notice** — surfaced when System Health has degraded mode on; explains
  reduced functionality.

---

## Content Rules

- Plain, reassuring language; never expose stack traces, internal ids (beyond an opaque
  correlation id), or any PHI.
- Always offer at least one forward action.
- Degraded-mode and maintenance copy align with the System Health / Degraded Mode controls.

---

## Accessibility

Centered card must be fully keyboard reachable, screen-reader announced (`role="alert"` for
error states), and high-contrast.

---

## Actions

- Retry
- Go Home
- Sign In
- Contact Support / View Status

---

## Pencil Notes

Create versions for:

- 403 / 404 / 500
- Offline (with queued actions)
- Maintenance
- Session expired
- Tenant suspended
- Degraded-mode notice
