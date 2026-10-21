# CHARTWARDEN_UI_DOCLENS_EXTRACTION_REVIEW

Version: 1.0
Status: Screen Specification
Module: DocLens Extraction Review (M22 + M32)

---

## Purpose

DocLens Extraction Review is where AI-extracted intake data is verified before it touches the
chart: classify the document, check each extracted field against the source image, triage
low-confidence and high-risk fields, and commit accepted values as **drafts** to the owning
modules. It is the human-in-the-loop boundary for DocLens.

---

## Primary Users

- Intake Nurse (upload, classify)
- RN Case Manager (review; required for high-risk fields)
- MD Reviewer

---

## Layout Pattern

Use Work Queue + Review Workspace.

```text
Page Header
KPI Strip
Extraction Queue  |  Review: Source Image (bounding boxes)  |  Fields + Confidence
```

---

## KPI Cards

- Ready for Review
- Low-Confidence Fields
- SUD-Flagged
- Discrepancies
- Awaiting Write-back

---

## Job Statuses

`Queued`, `Extracting`, `Verifying`, `Discrepancy Check`, `Ready for Review`, `In Review`,
`Committed`, `Write-back Complete`; plus `Discarded`, `Failed`.

---

## Review Workspace

- **Left:** source page image with bounding-box overlay; page classification (confidence
  < 0.75 prompts manual labeling).
- **Right:** per-field candidates with a confidence chip, risk level, and SUD flag. Each
  field: **accept / edit / reject**, with mandatory source-view confirmation before approval.

High-risk fields (medications, allergies, doses, code status, DPOA, advance-directive
content) have **no bulk-approve** and require RN-or-above; low-risk fields below threshold may
be bulk-approved within the gate.

---

## Discrepancies & SUD

- When an extracted value conflicts with an existing chart value, a discrepancy drawer
  requires confirmation before overwrite; high-risk overwrites require typed last-name
  confirmation.
- SUD detection raises a banner; the reviewer confirms (promotes a privacy flag on the
  patient) or rejects the false positive.

---

## Chart Write-back (drafts only)

Accepted fields write **drafts** (never auto-commit to signed/active) to: demographics/payer
(M05), problems (M07), assessment scores (M09), lab/DME orders (M11), medications (M12). A
permanent provenance trail links chart row → job → candidate → decision → page → model
versions.

---

## Empty State

"No documents awaiting extraction review." → Upload Intake Packet, View Completed.

---

## Actions

- Open review · confirm source view
- Accept / edit / reject field
- Resolve discrepancy
- Confirm / reject SUD
- Reclassify page
- Commit write-back

---

## Pencil Notes

Create versions for:

- Triage queue (low-confidence / SUD)
- Side-by-side review (bounding boxes + confidence)
- High-risk field (no bulk-approve)
- Discrepancy drawer
- SUD confirmation
- Write-back confirmation
