# CHARTWARDEN_UI_ORG_PROVIDER_LOCATION_SETUP

Version: 1.0  
Status: Screen Specification  
Module: Organization / Provider Entity / Location Setup

---

## Purpose

This screen manages tenant structure: Organization, ProviderEntity, and Location.

---

## Primary Users

- Administrator
- ChartWarden Ops
- Billing Manager

---

## Layout Pattern

Use Admin Hierarchy Layout.

```text
Organization Tree
Selected Entity Detail
Right: Configuration / Validation
```

---

## Hierarchy

- Organization
  - Provider Entity
    - Location

---

## Organization Fields

- Name
- Legal name
- Tax ID
- Billing contact
- Subscription status
- Tenant settings

---

## Provider Entity Fields

- CCN
- NPI
- Tax ID
- MAC jurisdiction
- Medicare settings
- Cost report settings

---

## Location Fields

- Name
- Address
- Phone
- Service area
- Staff assignments
- IDG team

---

## Actions

- Add provider entity
- Add location
- Edit settings
- Validate billing identifiers
- Archive location
