# CHARTWARDEN_UI_FIELD_SAFETY

Version: 1.0  
Status: Screen Specification  
Module: Field Safety

---

## Purpose

Field Safety supports clinician safety during home visits, geolocation-aware check-ins, safety flags, escalation, and supervisor visibility.

---

## Primary Users

- Field Clinicians
- Clinical Manager
- Scheduler
- Administrator

---

## Layout Pattern

Use Dashboard + Mobile Task Flow.

Desktop:

```text
Safety Dashboard
Staff Status Map/List
Active Alerts
Visit Safety Detail
```

Mobile:

```text
Current Visit
Check In / Check Out
Safety Alert
Emergency Escalation
```

---

## Desktop KPI Cards

- Staff in Field
- Late Check-ins
- Active Safety Alerts
- Geofence Exceptions
- Unresolved Escalations

---

## Staff Status List

Columns:

- Staff
- Current visit
- Check-in status
- Last location time
- Alert status
- Next visit
- Actions

---

## Patient Safety Flags

Examples:

- Aggressive pet
- Unsafe neighborhood
- Smoking / oxygen risk
- Access difficulty
- History of threats
- Requires two-person visit

---

## Mobile Actions

- Check in
- Check out
- Report safety issue
- Request help
- Call supervisor
- Emergency escalation

---

## Alert States

- Normal
- Late check-in
- Outside geofence
- Help requested
- Emergency
- Resolved

---

## Privacy Note

Location data should be shown only to authorized supervisors and only for operational safety purposes.

---

## Pencil Notes

Design both:

- Supervisor dashboard
- Field clinician mobile safety flow
