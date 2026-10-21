# CHARTWARDEN_UI_WOUND_CARE

Version: 1.0
Status: Screen Specification
Module: Wound Care (composed — M09 assessments, M08 encounters, M22 documents)

---

## Purpose

The Wound Care screen tracks wounds over time: staging, serial measurements, photos, tissue
and exudate characteristics, and a healing trend — promoting the wound detail that otherwise
lives as a single line item inside the Clinical Assessments Suite into a dedicated,
longitudinal surface.

---

## Primary Users

- RN / Wound-Care RN
- LPN/LVN
- MD / NP

---

## Layout Pattern

Use Patient Workspace + Documentation Workspace.

```text
Patient Banner
Wound Header (active wounds · last assessed)
Left: Wound List  |  Center: Wound Assessment + Healing Trend  |  Right: Prior / Orders / Braden
```

---

## Wound List

One entry per wound: anatomical location, type, current stage, status, last-assessed date.

Types / staging: pressure injury (Stage 1–4, Unstageable, Deep Tissue Pressure Injury) and
non-pressure (skin tear, surgical, arterial/venous, moisture-associated, malignant/fungating).

---

## Wound Assessment (center)

- Location (body map) · type · stage
- Measurements: length × width × depth (cm); undermining / tunneling with clock position
- Tissue (granulation / slough / eschar / epithelial %), exudate (amount / type), odor
- Peri-wound skin, pain, signs of infection
- Photo capture (stored via Document Management, consent-aware, secure)
- Treatment / dressing in use

---

## Healing Trend (right + center)

Surface area over time with healing / deteriorating indicator; prior assessments for
comparison; current Braden / skin-risk score (M09); linked dressing-change orders (M11) and
the care-plan problem this wound maps to.

---

## Statuses

- Wound: `Active`, `Healing`, `Healed`, `Closed`.
- Assessment capture: `Draft`, `Signed`, `Superseded` (correction chain, per M09).

---

## Mobile Behavior

Step-based capture; in-app photo with measurement entry; works offline with sync (photos and
measurements queue like other clinical captures).

---

## Empty State

"No wounds recorded for this patient." → Add Wound.

---

## Actions

- Add wound · record assessment
- Capture / annotate photo
- Link dressing order
- Compare / view trend
- Mark healing / healed

---

## Pencil Notes

Create versions for:

- Wound list (multiple wounds)
- Wound assessment form (measurements + body map)
- Photo capture + annotation
- Healing trend (improving vs deteriorating)
- Mobile step-based capture
