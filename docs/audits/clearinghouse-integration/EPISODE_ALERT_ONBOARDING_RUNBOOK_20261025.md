# Episode Alert vendor onboarding runbook (issue #762)

**Date:** 2026-10-25 · **Safety update:** 2026-11-18 · **Status:** checklist for a person. An engineering session may not contact the vendor, start a trial,
sign anything, create an account or handle a credential; every step below is human work.
Current questions (draft, not sent): [`EPISODE_ALERT_FOLLOWUP_QUESTIONS_20261118.md`](./EPISODE_ALERT_FOLLOWUP_QUESTIONS_20261118.md). Historical questionnaire: [`EPISODE_ALERT_QUESTIONS_TO_SEND_20261025.md`](./EPISODE_ALERT_QUESTIONS_TO_SEND_20261025.md).
Secrets: [`EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md`](./EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md).
Evidence and capability blockers: [`EPISODE_ALERT_ARCHITECTURE_AND_EVIDENCE_20261118.md`](./EPISODE_ALERT_ARCHITECTURE_AND_EVIDENCE_20261118.md).
Decisions this feeds: [ADR-0103](../../adr/ADR-0103-dde-access-provider-port.md) D7; issues #755, #758, #759, #760, #766.

## Owner roles

| Role | Does |
|---|---|
| Business owner | Reviews proposed account/commercial models and, only after separate authorization, decides whether to approach the vendor |
| Compliance / privacy officer | Reviews and signs the BAA; decides when PHI may flow; keeps the BAA register ([`CHARTWARDEN_INTEGRATIONS_v0_1.md`](../../architecture/CHARTWARDEN_INTEGRATIONS_v0_1.md) section 3.5 names it) |
| Provider enrollment owner | Handles MAC EDI and DDE enrollment for each hospice (the hospice is the enrolled party) |
| Platform operator | Only after approved onboarding, handles credentials per the secrets runbook; never pastes them anywhere else |
| Engineer | Files vendor documents here, then updates the UNVERIFIED markers and ADR-0103 D7 from the recorded answers |

## Checklist (in order; stop at any failed gate)

1. **Scope and authorization first.** A business owner must approve any vendor contact, account, or trial separately. This
   runbook and the prepared questions do not themselves authorize contacting Episode Alert, starting a trial, or creating an
   account. Public trial marketing does not establish an isolated sandbox. The adapter is unverified and its production factory
   refuses to bind.
2. **Confirm the account and test model in writing** before any trial/API operation. Ask whether the trial is isolated, whether
   calls can reach CMS/MAC/payer systems, which credentials select it, and whether synthetic requests are authorized. Until then,
   no vendor request is allowed by this engineering plan. A trial account is not automatically a sandbox.
3. **Use the prepared messages only after owner authorization:** send the Episode Alert message and the provider-enrollment
   owner's message to the applicable HH+H MAC. For Oregon, current CMS material places HH+H in J6 and identifies Wellpoint
   Federal (formerly NGS) effective 2026-04-01; verify the provider-specific desk, payer and transaction route rather than using
   a historical Oregon Part A identifier.
4. **HETS enrollment is per NPI/vendor relationship.** Under CMS validation effective 2026-05-11, each NPI sent through a
   third-party HETS submitter needs a current valid enrollment relationship with that vendor. This is separate from the hospice's
   Medicare provider enrollment, DDE access, and institutional claim/ERA authorizations.
5. **BAA and contract gate.** Compliance/legal reviews the actual applicable agreement and identifies the parties and data
   flows. The public BAA template is not a signed or approved ChartWarden agreement. No real MBI/PHI may be sent before the
   applicable contractual, security and provider authorization gates are met.
6. **Account model decision.** Resolve tenant-owned account versus isolated partner subaccounts versus a shared platform
   account. Do not treat ADR-0103 D2's proposed platform-held credential as approved or infer tenant isolation from billing NPI.
7. **Credentials.** Only after written account authorization, security/legal review and a separate activation plan may the
   designated platform operator handle a real credential under the secrets runbook. It must never be stored in the repository,
   ticket, chat, email, or logs.
8. **Record evidence.** File permitted guide/version metadata and written answers as described below. Local engineering can
   continue with synthetic fixtures and `LocalFakeHttpClient`; that fake has no
   network path and does not verify the vendor contract. Do not enable application calls based on environment variables or a
   trial key.
9. **Decide the NOE/NOTR route.** Confirm in writing whether each hospice notice is supported through institutional EDI,
   individually attributed DDE API, or only hosted/manual DDE. Use the existing port that matches the documented mechanism;
   do not force an EDI path through `DdeAccessProvider` or activate a second path for the same notice. If only hosted/manual
   support exists, preserve manual DDE and ask the maintainer whether to revise integration scope. Keep the issue open until
   the route, authorization and reconciliation behavior are decided and qualified.

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

One file per round, `EPISODE_ALERT_ANSWERS_<yyyymmdd>.md`, with a heading per question in the current questionnaire: date asked,
who answered, the answer quoted, and a label **Documented / Observed / Unverified** as in
[`STEDI_QUESTIONS_20261008.md`](./STEDI_QUESTIONS_20261008.md). In the same change:

- add the file to the table in [`README.md`](./README.md);
- change the UNVERIFIED comments and placeholders in `packages/x12-837-client/src/clearinghouse/episode-alert-transport.ts`
  (path, auth scheme, request body, exact approved origin) and `episode-alert-eligibility.ts` (root/element names) only after
  written documentation and a controlled synthetic response support them; a trial credential or email alone does not establish
  a sandbox or authorize activation (see the DoseSpot precedent, `docs/history/m12-dosespot-adapter.md`);
- update ADR-0103 D7 and the #755 task list.

## Exit criteria for #762

Account and partner model, guide/schemas, approved destination/authentication, test isolation, supported operations, operator
attribution, CMS HETS-per-NPI prerequisites, applicable MAC forms, agreements and security obligations are recorded with
provenance; no credentials or PHI are placed in this repository; ADR-0103 D7 and remaining architecture choices are reviewed.
Until the human/vendor steps are actually completed, #762 stays open. Public advertising and these prepared questions do not
satisfy those exit criteria.
