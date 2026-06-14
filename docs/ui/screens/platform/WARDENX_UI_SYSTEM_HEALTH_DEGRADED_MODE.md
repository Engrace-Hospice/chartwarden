# WARDENX_UI_SYSTEM_HEALTH_DEGRADED_MODE

Version: 1.0  
Status: Screen Specification  
Module: System Health / Degraded Mode

---

## Purpose

System Health shows current service status, degraded modes, incidents, integrations, and operational alerts.

---

## Primary Users

- WardenX Ops
- Administrator
- Engineering Admin

---

## Layout Pattern

Use Status Board.

```text
System Status Header
Service Cards
Incident Timeline
Integration Status
Degraded Mode Banner Controls
```

---

## Service Cards

- Backend
- Database
- Valkey
- MinIO
- Workers
- AI
- DoseSpot
- MAC portal
- Messaging
- Email/SMS

---

## Statuses

- Operational
- Degraded
- Partial Outage
- Major Outage
- Maintenance

---

## Actions

- Update status
- Create incident
- Post update
- Enable degraded mode banner
- Resolve incident
