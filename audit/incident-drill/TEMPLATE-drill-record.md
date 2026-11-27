# Incident-response drill record: `<scenario>` — `<YYYY-MM-DD>`

> **NOT A RECORD. This is the blank template.** Copy it to `<YYYY-MM-DD>-<scenario>.md`, delete this banner and fill every field.
> A form filled in for a drill that was not run is a false record. Never put PHI, key material, phone numbers, personal
> addresses or real names beyond role titles in this file. Guide: `docs/runbooks/incident-response-drill.md`.

## 1. Header

| Field | Value |
|---|---|
| Scenario | `phi-exposure` / `backup-key-leak` / `operator-compromise` (cards in `docs/runbooks/incident-response-drill-scenarios.md`) |
| Type | tabletop (no system changes, nothing sent outside the room) |
| Date and place | `<YYYY-MM-DD>`, `<room or call>` |
| Start / end (local) | `<HH:MM>` / `<HH:MM>` |
| Kit version | git commit of the kit when run: `<sha>` |
| Documents in force | DR/BCP version and last-reviewed date `<v, YYYY-MM-DD>`; OPS runbook `<v, YYYY-MM-DD>` |
| Real incident open at the time | no / yes (if yes, the drill is void) |

## 2. Participants and roster check (roles only; never contact details)

| Role | Played by (role title) | Stand-in (role title) | Paged by (channel) | Page tested in the last month? | Time to answer (`mm:ss`) or `untested` |
|---|---|---|---|---|---|
| Facilitator | | | n/a | n/a | n/a |
| Scribe | | | n/a | n/a | n/a |
| Incident Commander | | | | | |
| Technical Lead | | | | | |
| Communications Lead | | | | | |
| Compliance Officer | | | | | |
| Counsel (played or real) | | | | | |
| Customer liaison (played) | | | | | |
| Observer (optional) | | | n/a | n/a | n/a |

Access confirmed by looking, not by recalling: status-page admin `<yes/no>`; incident channel `<yes/no>`; alert webhook
`<yes/no/absent>`; sealed-envelope location known `<yes/no>`; backup-key escrow location known `<yes/no>`.
Roles held by the same person (DR/BCP section 2.1): `<list>`.

## 3. Clock fields (minutes:seconds after T0; `not reached` with a reason if no event)

| Field | Target | Actual | Met? | Note |
|---|---|---|---|---|
| `t_first_action` | 05:00 (OPS section 14.2) | | | |
| `t_declared` | 15:00 (provisional) | | | |
| `t_ic` | 5 min after declaring SEV-1 | | | |
| `t_tech_lead` | 15 min after declaring SEV-1 | | | |
| `t_containment_decided` | 30:00 (provisional) | | | |
| `t_evidence_preserved` | before the first irreversible step | | | |
| `t_counsel_compliance` | 60:00 (OPS section 14.4) | | | |
| `t_first_status_draft` | 15 min after declaring SEV-1 | | | |
| `t_scope_known` | 90:00 (provisional) | | | |
| `t_assessment_drafted` | 120:00 (provisional) | | | |
| `t_ce_notice_drafted` | within the BAA deadline `<N days>`; at most 60 days from discovery | | | |
| `t_stand_down` | n/a | | | |
| `t_pir_due` | 7 days after resolution | | | |

Severity declared: `<SEV-n>` at `<mm:ss>`, reason `<…>`; reclassified: `<none / SEV-n at mm:ss, reason>`.
Discovery time fixed by the Compliance Officer: `<T0 / earlier, why>`.

## 4. Inject log

Mark each expected action **done**, **partial** (wrong role, wrong document, or after a prompt) or **not found** (the facilitator
had to give it). Add a row per inject from the scenario sheet.

| Inject | Read at | Expected action (from the card) | Result | Document or route the group named | Role who decided | Time | Note |
|---|---|---|---|---|---|---|---|
| `<n.0>` | `00:00` | | | | | | |

## 5. Decisions and drafts

| Decision or draft | Role | Time | Basis (document, section) | `[DRILL]` draft kept? |
|---|---|---|---|---|
| Severity | | | | n/a |
| Containment lever and approver | | | | n/a |
| Breach-assessment conclusion and who owns it | | | | |
| Covered-entity notice (per tenant) | | | | |
| Status-page entry | | | | |

Drafts hold no PHI, key material or exploit detail: `<confirmed by scribe yes/no>`.

## 6. Findings

Every finding has an owner role and a due date before this file is filed. A finding is **blocking** if the responders could not
have contained the incident or met a legal deadline with the procedures as written.

| # | Finding (what could not be found, was wrong, or was missing) | Section or system | Blocking? | Fix (runbook / product / infra / staffing) | Owner role | Due (`YYYY-MM-DD`) | Tracked in (issue or PR) |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |

Runbook defects found (the section and what the document said versus what was true): `<list or none>`.
Last drill's findings checked: `<closed / still open: list>`.

## 7. Outcome

- Expected actions: done `<n>` / partial `<n>` / not found `<n>`.
- Open blocking findings: `<n>`. Re-run required for: `<scenarios or none>`.
- What the group would do differently on the first day: `<…>`.

## 8. Sign-off (by role; a typed role and date, no personal contact)

| Role | Name field (role title) | Date |
|---|---|---|
| Security officer | | |
| Facilitator | | |
| Incident Commander (as played) | | |
