# CHARTWARDEN_UI_FEATURE_FLAGS

Version: 1.0  
Status: Screen Specification  
Module: Feature Flags

---

## Purpose

Feature Flags controls tenant-level and platform-level feature access, phased rollouts, AI routing, and kill switches.

---

## Primary Users

- ChartWarden Ops
- Administrator where allowed
- Engineering/Admin

---

## Layout Pattern

Use Work Queue.

```text
Feature Header
Flag Table
Right: Flag Detail / Rollout Rules
```

---

## Flag Types

- Clinical feature
- Billing feature
- Compliance feature
- AI capability
- Integration
- Experiment
- Kill switch

---

## Flag Table Columns

- Flag
- Category
- Status
- Tenants enabled
- Risk
- Last changed
- Owner

---

## Detail Panel

- Description
- Default state
- Tenant overrides
- User/role targeting
- Rollout percentage
- Audit history
- Dependencies

---

## Actions

- Enable
- Disable
- Add tenant override
- Roll back
- Activate kill switch
