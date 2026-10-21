# CHARTWARDEN_UI_SUPPLIES_DME_COMFORT_KIT

Version: 1.0  
Status: Screen Specification  
Module: Supplies / DME / Comfort Kit

---

## Purpose

This screen manages DME, supplies, comfort kits, delivery tracking, vendor coordination, and pickup after discharge/death.

---

## Primary Users

- RN
- Office Manager
- Supply Coordinator
- DME Coordinator
- Administrator
- Biller

---

## Layout Pattern

Use Patient Workspace + Work Queue.

Patient view:

```text
Patient Banner
DME / Supplies Summary
Orders / Deliveries
Right: Vendor / Status / Tasks
```

Global queue:

```text
KPI Strip
Supply/DME Queue
Right Detail Panel
```

---

## KPI Cards

- Open Requests
- Pending Delivery
- Delivery Overdue
- Pickup Needed
- Comfort Kits Pending

---

## Item Types

- Oxygen
- Hospital bed
- Wheelchair
- Walker
- Commode
- Wound supplies
- Incontinence supplies
- Comfort kit
- Other DME

---

## Queue Columns

- Patient
- Item
- Vendor
- Status
- Requested date
- Delivery date
- Pickup date
- Owner
- Actions

---

## Statuses

- Requested
- Ordered
- Scheduled
- Delivered
- In Use
- Pickup Requested
- Picked Up
- Canceled

---

## Actions

- Request DME
- Order supplies
- Confirm delivery
- Schedule pickup
- Message vendor
- Upload confirmation

---

## Compliance/Billing Notes

Show whether item is:

- Hospice-covered
- Patient-owned
- Vendor-supplied
- Requires documentation
