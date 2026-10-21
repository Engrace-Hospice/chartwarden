# CHARTWARDEN_UI_ROLES_PERMISSIONS

Version: 1.0  
Status: Screen Specification  
Module: Roles & Permissions

---

## Purpose

Roles & Permissions controls RBAC, ABAC, location scopes, all-location flags, and sensitive access.

---

## Primary Users

- Administrator
- Compliance Officer
- ChartWarden Ops

---

## Layout Pattern

Use Admin Split Layout.

```text
Role List
Permission Matrix
Right: Role Detail / Audit
```

---

## Role List

Shows:

- Role name
- Category
- Users assigned
- System/default/custom
- Status

---

## Permission Matrix

Rows:

- Permission groups

Columns:

- View
- Create
- Edit
- Delete
- Sign
- Approve
- Export
- Admin

---

## Special Controls

- PHI read access
- Billing access
- Compliance access
- Admin access
- Auditor mode
- External collaborator access

---

## Actions

- Create role
- Duplicate role
- Edit permissions
- Assign users
- View audit
- Deactivate role
