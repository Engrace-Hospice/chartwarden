# Episode Alert vendor onboarding runbook (issue #762)

**Date:** 2026-10-25 · **Status:** checklist for a person. An engineering session may not contact the vendor, start a trial,
sign anything, create an account or handle a credential; every step below is human work.
Questions to send: [`EPISODE_ALERT_QUESTIONS_TO_SEND_20261025.md`](./EPISODE_ALERT_QUESTIONS_TO_SEND_20261025.md).
Secrets: [`EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md`](./EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md).
Decisions this feeds: [ADR-0103](../../adr/ADR-0103-dde-access-provider-port.md) D7; issues #755, #758, #759, #760, #766.

## Owner roles

| Role | Does |
|---|---|
| Business owner | Starts the trial (vendor site and phone line are in #755) and accepts pricing |
| Compliance / privacy officer | Reviews and signs the BAA; decides when PHI may flow; keeps the BAA register ([`CHARTWARDEN_INTEGRATIONS_v0_1.md`](../../architecture/CHARTWARDEN_INTEGRATIONS_v0_1.md) section 3.5 names it) |
| Provider enrollment owner | Handles MAC EDI and DDE enrollment for each hospice (the hospice is the enrolled party) |
| Platform operator | Stores the API key per the secrets runbook; never pastes it anywhere else |
| Engineer | Files vendor documents here, then updates the UNVERIFIED markers and ADR-0103 D7 from the recorded answers |

## Checklist (in order; stop at any failed gate)

1. **PHI gate first.** Decide in writing that trial traffic uses synthetic data only until step 5. The adapter has no test
   mode (it refuses `usage: "test"`), so a trial call is a real HETS-backed call: no real MBI before the BAA.
2. **Start the 14-day trial** (business owner) with a company-owned shared mailbox, not a personal address. Record trial start
   and end dates, the account email and the vendor contact in the answers file. Put a reminder on day 10; the trial is short
   and the questions must be answered inside it.
3. **Request the API guide and sample calls, and the BAA,** and send Message 1 of the questions document the same day.
4. **Send Message 2 to the MAC** (provider enrollment owner), one per customer jurisdiction, in parallel. MAC replies are the
   slow step.
5. **BAA gate.** Compliance signs the BAA, or records why none is needed, and files the executed copy with the company's other
   executed agreements (not in this repository). Only after this may a real MBI go to the vendor.
6. **Credentials.** The platform operator stores the key and base URL exactly as the secrets runbook says: nothing in the
   repository, a ticket, a chat, an email or a log.
7. **Record the answers** (below) and update the build.
8. **Decide.** Engineering reads the answers against the blocking table in the questions document and updates ADR-0103 D7:
   either per-operator write endpoints exist (unblocks #759) or they do not (the port stays `manual` and only the documented
   API is used). The product owner confirms; label #762 `needs-decision` while waiting on that call.

## What to attach to this folder

Only documents the vendor allows to be shared, with no secret and no real beneficiary data:

| Attach | Name | Do not attach |
|---|---|---|
| API guide, schemas, error list | `EPISODE_ALERT_API_GUIDE_<yyyymmdd>.<ext>` | Anything containing an API key, token or account number |
| Sample calls and sample XML responses | `EPISODE_ALERT_SAMPLES_<yyyymmdd>.md` | A response for a real MBI; redact it or use the vendor's sample data |
| Written answers (email text) | `EPISODE_ALERT_ANSWERS_<yyyymmdd>.md` | The signed BAA, pricing or contract terms |
| MAC enrollment answers | the same answers file, MAC section | A DDE user ID or password |

If the guide forbids redistribution, record its title, version and date in the answers file and say where the company keeps it.

## Recording answers

One file per round, `EPISODE_ALERT_ANSWERS_<yyyymmdd>.md`, with a heading per question number in the questions document (EA 1 to
13, MAC 1 to 6): date asked, who answered, the answer quoted, and a label **Documented / Observed / Unverified** as in
[`STEDI_QUESTIONS_20261008.md`](./STEDI_QUESTIONS_20261008.md). In the same change:

- add the file to the table in [`README.md`](./README.md);
- change the UNVERIFIED comments and placeholders in `packages/x12-837-client/src/clearinghouse/episode-alert-transport.ts`
  (path, auth scheme) and `episode-alert-eligibility.ts` (element names) only after a response from the trial account confirms
  them, never from an email alone (the DoseSpot precedent, `docs/history/m12-dosespot-adapter.md`);
- update ADR-0103 D7 and the #755 task list.

## Exit criteria for #762

BAA decision recorded; guide and samples (or where they are kept) recorded; EA 4 to 10 and MAC 1 and 2 answered in writing;
credential stored per the secrets runbook; ADR-0103 D7 resolved one way or the other. Until then #762 stays open.
