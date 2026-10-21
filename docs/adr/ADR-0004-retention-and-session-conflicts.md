# ADR-0004 — Session lifetimes (OPEN-020), clinical retention (OPEN-021), retention-override ownership (OPEN-022)

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 0 (architecture correction)
- **Resolves:** OPEN-020, OPEN-021, OPEN-022; M01-F03, M02-F11/F12, M03-F11; cross-cutting X5
- **Changes:** `CHARTWARDEN_ARCHITECTURE_v0_11.md` §24.1 (Sessions row; Clinical record + HOPE rows; §14 retention headline; §25.9)

The audit surfaced three architecture-internal conflicts the corpus left open. This ADR closes
all three. The general rule: **§7/§14 and the v0.11 audit-retention reconciliation govern; the
older §24.1 numbers that contradict them are corrected.**

## OPEN-020 — Interactive session lifetimes

**Conflict.** §7/§14 say "15 min idle, 8 hr absolute, 5 min UI screen lock"; §24.1's *Sessions*
row said "default 8 hours max idle, 24 hours absolute"; SECURITY_HARDENING v0.2 reconciled to
"15 min idle / 8 hr work-session / 24 hr maximum."

**Decision.** Interactive session policy is:

- **Idle timeout: 15 minutes**
- **Work-session (soft absolute): 8 hours**
- **Hard absolute (maximum): 24 hours**
- **UI screen lock: 5 minutes**

The §24.1 *Sessions* row is corrected to these values. The canonical session-context RLS
variable is **`app.org_id`** (set by `withOrgContext()`); specs using `app.organization_id` /
`app.tenant_id` / etc. are defects (X4). Auditor/collaborator/funeral session durations are
unchanged (M2 D1 values stand).

## OPEN-021 — Clinical-record retention

**Conflict.** §14 says "7 years clinical (or longer per state)"; §24.1 set the clinical-record
default at "6 years from last patient contact." v0.11 already reconciled `audit_event` compliance
retention to 7 years; clinical-record was left split.

**Decision.** **Clinical-record retention default = 7 years from last patient contact** (HIPAA
floor is 6 years per §164.530(j)(2); we standardize on 7, which also satisfies states that
require 7 without an override). HOPE assessments / HIS records match the clinical record (7
years). State law requiring **longer** is applied via `state_retention_override` (Oregon = 7;
minors until age 21; etc.). The anchor is **last patient contact**, never record-creation date.

§24.1 clinical-record and HOPE rows, and the §14 headline, are aligned to 7 years. **Bereavement
letters and telehealth recordings are records of care** — their display/program windows
(13-month bereavement, 90-day recording default) are **not** retention limits and must never
trigger destruction before the 7-year clinical class (M16, M22, M31 defects).

## OPEN-022 — `state_retention_override` ownership

**Conflict.** §25.9 attributed state retention overrides to "Module 39 (Consent)"; §24.4 and the
module manifest place the `state_retention_override` table under **Module 4 (Audit & Compliance
Log)**.

**Decision.** **Module 4 owns `state_retention_override`** (the manifest governs ownership). §25.9
is corrected to point to Module 4 for retention overrides; Module 39's "state-specific behavior"
example is re-pointed to its consent/redisclosure rules, not retention. Module 24 retains its
Medicaid state-adapter example.

## Consequences

- M01 retention constants change 6→7 (three places); M02/M03 remap their invented `security`
  retention class to `compliance` and their RLS variable to `app.org_id`.
- The destruction/retention engine (M4) anchors clinical destruction to last-patient-contact + 7
  years, honoring `state_retention_override` and legal hold.
