# CHARTWARDEN_UI_AUDIT_LOG_VIEWER

Version: 1.0  
Status: Screen Specification  
Module: Audit Log Viewer

---

## Purpose

Audit Log Viewer enables authorized users to search PHI access, user actions, system events, AI activity, and compliance-relevant history.

---

## Primary Users

- Compliance Officer
- Administrator
- Security Officer
- Auditor
- ChartWarden Ops

---

## Layout Pattern

Use Work Queue.

```text
Page Header
Filter Bar
Audit Event Table
Right: Event Detail Panel
```

---

## Filters

- Date range
- User
- Patient
- Entity type
- Action
- Module
- IP/device
- AI capability
- Severity

---

## Table Columns

- Timestamp
- Actor
- Action
- Entity
- Patient
- Module
- Risk
- Source
- Actions

---

## Detail Panel

- Full event detail
- Before/after where allowed
- Patient context
- Session metadata
- IP/device
- Related events
- Export controls

---

## Actions

- Search
- Export
- Save query
- Open related patient
- Create investigation

---

## Security

Audit export requires elevated permission and logs its own audit event.
