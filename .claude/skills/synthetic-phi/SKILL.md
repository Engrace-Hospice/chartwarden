---
name: synthetic-phi
description: How to create test patients, fixtures and seed data for ChartWarden without real PHI — which identifier values are allowed and how to add one. Use when writing tests, fixtures, seeds, stories or demo data that need SSNs, MBIs, names, DOBs or addresses.
---
# Synthetic PHI for ChartWarden

The PreToolUse guard and `harness:phi-scan` refuse SSN- and MBI-shaped values that aren't known
synthetic. Use these:

| Need | Use |
|---|---|
| SSN | Area `000`, `666` or `9xx` (never issued; e.g. `900-12-3456`), or a value already in `compliance/synthetic-identifiers.json`. |
| MBI | `1EG4TE5MK73` (CMS's published example) or another value in the registry. |
| Name | Obviously invented (`Jane Testpatient`, `Flip Other`). Never a real patient, staff member or public figure. |
| DOB / dates | Fixed synthetic dates, or dates relative to a fixed test clock. |
| Address / phone | `555-01xx` phone numbers, `123 Test St`, ZIP `00000`. |
| NPI | Real NPIs are public provider ids and allowed. Use the NPI registry tool to check one, or `1234567893` (Luhn-valid). |

Need a new MBI-shaped value (e.g. to test a checksum or a format edge case)? Add it to
`compliance/synthetic-identifiers.json`. Claude Code will ask the human to approve the edit. That
approval is the control.

Never derive fixtures from production data, not even redacted, shuffled or "anonymized" exports.
De-identification under §164.514 is a separate, documented process and not a coding shortcut.
