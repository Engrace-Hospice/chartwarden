# CHARTWARDEN_UI_SUPPORT_IMPERSONATION_AUDIT

Version: 1.0  
Status: Screen Specification  
Module: Support / Audited Impersonation

---

## Purpose

This screen supports safe, audited support access to tenant environments.

---

## Primary Users

- ChartWarden Support
- Security Officer
- Compliance Officer

---

## Layout Pattern

Use Gated Action Flow.

```text
Tenant / User Selection
Reason for Access
Approval / Controls
Session Activity
Audit Log
```

---

## Required Before Access

- Tenant selected
- User/session scope selected
- Reason entered
- Duration selected
- Approval if required
- PHI warning acknowledged

---

## During Session

Show persistent banner:

"Support mode active. All actions are audited."

---

## Actions

- Start session
- End session
- Extend with reason
- Export support audit
- Report issue

---

## Audit Requirements

Log:

- Support user
- Tenant
- Scope
- Reason
- Start/end
- Actions taken
- PHI accessed
