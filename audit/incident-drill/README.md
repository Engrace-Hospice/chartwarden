# Incident-response drill records (CW-IR-01)

Evidence that the incident procedures were exercised by the real responders. The kit that produces these records is
[`docs/runbooks/incident-response-drill.md`](../../docs/runbooks/incident-response-drill.md) (script, roles, clocks, scoring) and
[`docs/runbooks/incident-response-drill-scenarios.md`](../../docs/runbooks/incident-response-drill-scenarios.md) (the scenarios).

**No drill has been run yet, so this folder holds no record.** `TEMPLATE-drill-record.md` is a blank form, not evidence. Do not
fill one in for a drill that did not happen, and do not commit a partly filled one.

## Filing a record

- One file per scenario run: `<YYYY-MM-DD>-<scenario>.md`, where `<scenario>` is `phi-exposure`, `backup-key-leak` or
  `operator-compromise`. Copy `TEMPLATE-drill-record.md`, remove its "NOT A RECORD" banner and fill every field. A field with no
  event is written `not reached` with a reason; never left blank.
- Signed (by role) by the security officer and the facilitator, and filed within the number of working days the owner sets at
  the first drill.
- Retained **6 years** with the other contingency-plan evidence (45 CFR 164.316(b)(2)(i)).

## What a record must never contain

- PHI of any kind, including a real patient name, identifier, screenshot or audit row. The scenarios use invented patients.
- Key, token, password or passphrase material, or a fragment of one.
- Phone numbers, personal email addresses, home addresses or real names beyond role titles. The roster records the *role*, the
  *channel* and whether the page was reached.
- A real vendor, regulator, insurer or law-enforcement contact. Drills draft messages; they send none.

`bun run harness:phi-scan` and `bun run arch:fitness` run over this folder like the rest of the repo.

## Register link

Compliance register row `CW-IR-01` (`compliance/controls.yaml`) lists the template and the kit as evidence and states that the
drill itself is the remaining gap. When a record is filed, the security officer decides whether the row's status or gap text
changes; one scenario is evidence of an exercise, and the row should say which scenarios have and have not been run.
