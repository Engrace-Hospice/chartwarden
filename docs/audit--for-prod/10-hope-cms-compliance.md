# 10 — HOPE and CMS compliance

The HOPE module has specification data, answer engine, scheduling/retention, assessment recording,
validation, submission packaging, and correction-oriented surfaces. Targeted live suites passed 61
tests across the specification foundation, answer engine, writes, and retention.

## Current-source comparison

CMS's current HOPE page lists v1.03 Admission, HUV, Discharge, All-Item, and Guidance Manual
materials. CMS also states the October 2026 manual changes do not change the current data
specifications, so the repository's `v1_00_1` specification directory was not called stale merely
from its label.

The v1.03 guidance/change table clarifies that an LPN/LVN may conduct and complete an SFV where the
hospice determines that discipline appropriate. The code states CMS restricts SFV to RN/NP and
enforces that at ABAC and service layers (`CW-QA-0006`). This is an over-restriction and inaccurate
regulatory attribution, not evidence that an invalid HOPE record was submitted.

Source: [CMS HOPE program page](https://www.cms.gov/medicare/quality/hospice/hope),
[HOPE Guidance Manual v1.03](https://www.cms.gov/files/document/hope-guidance-manual-v-1-03-508c-pdf.pdf),
and [v1.02→v1.03 change table](https://www.cms.gov/files/document/hope-v1-02-hope-v1-03-guidance-manual-item-set-change-table-508c-pdf.pdf).

## Not verified

iQIES end-to-end submission/acknowledgement, production specification seeding, every timing edge
(transfer/readmission/date anchors), correction/retraction against CMS, facility policy, and complete
item-by-item semantic mapping. A label or generated export alone is not treated as CMS conformance.
