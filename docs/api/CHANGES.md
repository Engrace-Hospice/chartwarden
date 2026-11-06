# ChartWarden API — changes for integrators

Dated notes on API changes an integrator has to act on. The machine-readable contract is
[`openapi.json`](./openapi.json) (regenerated with `bun run openapi:emit`); every field named below carries
its full description there. Newest first.

---

## 2026-11-06 — Admin console reads for the tenant onboarding wizard

**Why.** The platform-ops console now runs tenant onboarding as one ordered wizard. It needs a few reads and one relaxed field.

- `GET /api/v1/platform/tenant-invitations` accepts `?tenantAccountId=<uuid>` and returns only that tenant's invitations (a malformed id is a
  `422`). Without it the list is unchanged (every tenant, newest first).
- New `GET /api/v1/platform/tenants/{orgSlug}/members` (platform ops; `tenant_onboarding_data.read_platform`): a tenant's **active** staff
  (`membershipId`, `displayName`, `email`, `roleKeys`) so an operator can pick the compliance officer by name. Read on the tenant's own
  scope and audited; capped at 500.
- `GET /api/v1/platform/tenants` and `GET /api/v1/platform/tenants/{orgSlug}` carry `onboardingProgress`
  (`doneCount`, `totalCount`, `currentStepKey`, `goLiveState`), judged over the gating wizard steps. On the overview the older
  `onboarding.{totalTasks,doneTasks,currentStep}` now follow the same rule: they used to count every task row, retired history
  included, and to name whichever pending row came back first.
- `POST /api/v1/platform/tenants` no longer requires `planLabel`. The retired flat tier is replaced by the census-banded contract signed at
  onboarding step 2, so an omitted label is stored as `"unassigned"`. A label that is sent must still be `starter`, `standard` or `enterprise`.

---

## 2026-11-06 — Tenant lifecycle transitions refuse a stale status

**Why.** Two operator transitions racing on one tenant were last-writer-wins, and the status ledger recorded the wrong
from-status.

- `POST /api/v1/platform/tenants/{orgSlug}/status` and `POST /api/v1/platform/tenants/{orgSlug}/offboard` answer
  `409 TENANT_STATUS_CHANGED` when another transition changed the tenant's status while the request was waiting. Nothing is
  written; reload the tenant and retry.

## 2026-11-05 — Tenant pricing: census-banded plans, a signed contract, and a monthly statement

**Why.** The flat starter / professional / enterprise tiers are retired. A tenant now signs a *census-banded* plan version at
onboarding step 2: the monthly platform fee is the **greater of** (active staff accounts x the per-user price) and the flat fee of the
average-daily-census band the tenant falls in, plus a percentage of net collections when the tenant bills through ChartWarden. The default
bands are five: 0-9, 10-16, 17-25, 26-29 and 30+ patients (`GET /api/admin/pricing/defaults` returns `[0, 10, 17, 26, 30]`). Every
price is a column on a plan version and a published version is frozen, so a tenant keeps the price it signed. Money is integer cents,
rates are basis points.

### 1. What changes for existing clients

- `tier` on plan and subscription responses can now be `census_banded` (the three old values stay readable on existing rows).
- `GET /api/v1/plans` (the tenant catalog) never lists a `census_banded` plan, and the retired flat plans are no longer offered.
- `POST /api/v1/subscription` and `PATCH /api/v1/subscription` answer `404` for a `census_banded` slug (exactly what a plan that does not
  exist answers), and `403 PLAN_ASSIGNED_BY_OPERATIONS` for a tenant that is already on one; so does `POST /api/v1/subscription/cancel`: a
  contracted plan is assigned and ended by ChartWarden operations.
- `POST /api/admin/subscriptions/{id}/pause`, `/resume` and `/cancel` now check the subscription's status under a row lock and answer
  `409` with a stable code instead of acting on any status: `SUBSCRIPTION_NOT_PAUSED` (resume of a subscription that is not paused),
  `SUBSCRIPTION_CANCELED` (pause or cancel of a canceled subscription: it is final), `SUBSCRIPTION_ALREADY_PAUSED` (pause of a paused
  one). A refused request writes nothing. They answer `503 AUDIT_UNBOUND` when the platform audit writer is not bound.
- `POST /api/admin/plans` no longer accepts `tier: census_banded`; `activate`, `deprecate` and `meters` on such a plan answer
  `403 PLAN_ASSIGNED_BY_OPERATIONS` (use the pricing plan editor below), and the legacy edit and activate answer `409` for a retired flat plan.

### 2. New routes

| Route | Who | Guards |
|---|---|---|
| `GET /api/admin/pricing/defaults`, `GET /api/admin/pricing/plans[/{id}]` | platform billing roles | `plan.admin.read` |
| `POST /api/admin/pricing/plans` (draft), `PUT .../{id}` (replace a draft), `POST .../{id}/publish`, `/new-version`, `/archive` | platform billing roles | `plan.admin.write`, step-up, no AI actor, `Idempotency-Key`, body `reason` |
| `GET /api/v1/platform/pricing/plans`, `POST /api/v1/platform/pricing/preview` | platform ops and billing roles | `subscription.pricing_read_platform` |
| `GET /api/v1/platform/tenants/{orgSlug}/subscription` | platform ops and billing roles | `subscription.pricing_read_platform` |
| `POST /api/v1/platform/tenants/{orgSlug}/subscription` | `platform_ops` only | `subscription.onboard_platform`, `tenant_lifecycle_platform_ops`, step-up, no AI actor, `Idempotency-Key`, body `reason` |
| `PUT /api/v1/platform/tenants/{orgSlug}/subscription/billing-service-mode` | `platform_ops` only | same |
| `GET /api/v1/subscription/pricing` | the tenant | `subscription.read` (read-only) |

`POST .../subscription` signs the tenant onto a published plan version in one transaction (subscription, contract, `m35.subscription.created`,
audit row) and then settles the wizard's `plan_contract` step through the wizard. It refuses while an earlier step is unsettled
(`409 ONBOARDING_STEP_OUT_OF_ORDER`) or once the tenant is live (`409 TENANT_NOT_ONBOARDING`). The response carries
`planContractStep.status`: `settled`, `already_settled`, or `pending` (the subscription exists but the step could not be settled; repeat the
same POST to resume, nothing is duplicated).

`billingServiceMode` is `none` (the tenant bills outside ChartWarden, no percentage), `billing_software` or `managed_billing`. The mode is an
effective-dated history: a change takes effect from the **1st of the next month** (the contract view shows it as `pendingBillingServiceMode`), and
immediately only while the tenant is still onboarding with no statement yet. A statement prices with the mode in force for its period, and a
month that is already final can never be re-dated. `GET .../subscription` writes a read-audit row naming the operator.

### 3. The statement

One statement per subscription per UTC month, `draft` while the month is open and `final` once it is closed (five days after month end, so
late-posted remittances dated inside the month still count). It shows both sides of the greater-of rule, the meters it used (active staff
accounts, average daily census with its days observed, net collections with its remittance and pending counts) and the total. The tenant reads
its latest statement on `GET /api/v1/subscription/pricing`; it never carries the ChartWarden operator who signed the contract.

- **Charged from go-live, by days.** The platform fee and the plan minimum are charged by `inputs.daysLive / inputs.adcDaysInPeriod`: the
  subscription's live days in the month, the go-live day (and a cancel day) counting in full, half up to the cent. A go-live on the 1st is a whole
  month; mid-month it is a part. The implementation fee is not prorated. The billing percentage is on what was collected, so it is naturally partial.
- **The minimum floors the platform fee only.** `minimumAdjustmentCents` lifts the (prorated) platform fee to the (prorated) plan minimum; the billing
  fee is added on top.
- **Late money is never lost.** A remittance dated inside a closed month that posts after the month finalized is billed on the next open
  statement as a `priorPeriodLines` entry stored with its source month and that month's own rate (`priorPeriodFeeCents`), and never re-bills the
  closed month. After a subscription ended, a settlement statement (`daysLive` 0) carries it.
- **`needsReview`** marks a statement an operator should look at: its staff count fell back to the unfiltered ledger, or a remittance of the month had
  not posted when it closed. Statements finalize on schedule either way.
- **A canceled or paused subscription** is billed for the days it was live; a month already closed finalizes whatever the subscription has become.
- New fields on the statement and contract views: `inputs.daysLive`, `priorPeriodLines`, `priorPeriodFeeCents`, `needsReview`,
  `pendingBillingServiceMode`; the price preview takes an optional `plannedGoLiveOn` and returns `firstMonthDaysLive` / `firstMonthDaysInPeriod`.

### 4. Later changes to the same release

- `POST /api/v1/subscription/resume` and `POST /api/v1/subscription` answer `403 PLAN_ASSIGNED_BY_OPERATIONS` for a tenant that holds a
  contracted subscription (resuming one, or starting another beside a paused one): a contracted subscription is paused and resumed by ChartWarden
  operations. A pause that was left open (the subscription was resumed by a path that wrote no history row) now closes at the subscription's last
  write instead of billing nothing for ever.
- `POST /api/v1/roles` answers `422 RESERVED_ROLE` for the key `external_auditor` (whatever the category): that role is created by the system on the
  first auditor redemption, and an auditor is only ever attached to it. The database refuses the same for any other writer.
- A platform operator's pause, resume and cancel of a subscription no longer write the operator into the tenant-readable state history (or its
  audit copy); they write a platform-scoped audit row (`m35.subscription.platform_paused|resumed|canceled`) that names the operator and the tenant.
- The onboarding evidence note for step 2 (tenant-readable) no longer carries the order-form reference.
- A settlement statement (`daysLive` 0, carrying late money after a cancel or pause) now finalizes after its grace like any other, and prior-period
  money rides the EARLIEST open statement only (a later draft does not carry it again).
- A closed month with no census day is recorded once per subscription-month for review (platform-only) instead of being logged every hour.
- The staff count excludes an auditor or platform operator by what they WERE when they signed in (recorded in the staff ledger), not by their roles at
  statement time, so changing a member's roles afterwards cannot move them on or off the bill.
- The band is chosen on the exact mean (patient-days against threshold x days), not the rounded ADC shown.
- A published plan version and a final statement cannot be deleted; a tenant reads its contract's identity and start only (not who signed, why, or the
  order form).

---

## 2026-11-05 — Onboarding wizard v2, pre-PR review fixes (go-live integrity)

**Why.** The pre-PR review found ways one operator could open a tenant, or approve a go-live on data nobody had checked. These
change what the existing routes refuse.

- `POST /api/v1/platform/organizations/{organizationId}/status` with `event: "activate"` is refused
  `409 GO_LIVE_TWO_PARTY_REQUIRED` while the organization's tenant is provisioning or onboarding. The organization opens only
  through go-live approval; once the tenant is `active` the same call (a manual retry) is accepted.
- `POST /api/v1/platform/tenants/{orgSlug}/go-live/approve` is **repeatable**: once the tenant is active with an approved
  attestation, repeating it skips the guards and only finishes the organization's activation. A failed first activation now
  answers `503 ORGANIZATION_ACTIVATION_FAILED` (it was a 500) and says to repeat the approval; the daily onboarding sweep also
  opens any organization still `created` whose tenant is active. `409 GO_LIVE_APPROVER_WROTE_BAA` refuses an approver who
  recorded or last changed the governing BAA record.
- **Platform staff cannot be the compliance officer or the go-live attester.** `PUT .../compliance-officer` (both surfaces) and
  `POST /api/v1/tenant/go-live/attest` answer `422 COMPLIANCE_OFFICER_PLATFORM_STAFF` for a member whose user is the acting
  operator, is bound to `platform_alert_audience` in the tenant, or holds a platform role at home; an attestation whose attester
  became staff is `409 GO_LIVE_ATTESTATION_STALE` with detail `attester_platform_staff` at approval.
- **A pending attestation does not survive a data change.** Any write to the onboarding data (provider entities, locations, MAC
  and Medicaid credentials, the org profile, the platform BAA register) revokes a pending go-live attestation in the same
  transaction (`revokeReason`: "onboarding data changed after attestation"); the go-live step returns to pending and the officer
  attests again.
- `POST /api/v1/platform/baa-register` takes an optional `documentId`; an `executed` BAA needs one on create and on update
  (`422 BAA_DOCUMENT_REQUIRED`). A duplicate attestation or duplicate (tenant, addendum) BAA record is `409`, not `500`.
- The platform operator's `reason` on onboarding-data writes is screened for patient identifiers like every wizard free text
  (`422 EVIDENCE_LOOKS_LIKE_PHI`), and a write now runs the onboarding advance after it commits.
- `PATCH /api/v1/orgs/{id}` (the organization's display and legal name) and `POST .../admin/billing/npi-verifications/{id}/verify`
  and `/revoke` (the `ccn_registered` step's data) also revoke a pending go-live attestation in the same transaction, like every
  other write to the onboarding data. An operator's void records their user (a membership is recorded only when it is the
  user's own active membership of that organization).
- A deadlock or serialization failure (`40P01`, `40001`) is `409 CONCURRENT_UPDATE` ("retry it"; nothing was saved), not a 500.
- Go-live approval takes the exclusive onboarding lock before it reads anything and judges the attestation as it is under that
  lock; activation re-checks that the attester is still the assigned officer (`409 GO_LIVE_ATTESTATION_STALE`).
- A session on an organization that is not `active` (created, suspended, closed or unknown) is confined to an exact list of
  onboarding routes; every other route answers `403 ORGANIZATION_ONBOARDING`, including the tenant DSAR / export downloads,
  support-consent grants, the care-team staff list, member credentials and direct user provisioning.

---

## 2026-11-05 — Onboarding wizard v2: ordered steps, attestation with evidence, two-party go-live

**Why.** Tenant onboarding is now an ordered wizard that the server enforces. A step can only be started, completed, attested
or skipped when every earlier required step is done or skipped (`409 ONBOARDING_STEP_OUT_OF_ORDER`). A human marks a step done
by attesting with evidence. Going live takes two people: the tenant's compliance officer attests readiness, then a platform
operator approves; the daily sweep no longer activates a tenant. The Xero and payroll steps are retired.

### 1. `GET /api/v1/platform/tenants/{orgSlug}/onboarding` and `GET /api/v1/tenant/onboarding` — new fields

Both return `steps` (ordered): `key`, `title`, `owner` (`platform_ops` | `org_admin` | `compliance_officer` | `either`),
`sequence`, `optional`, `status`, `locked` and `lockedBy`, `completionMode` (`auto` | `attestation` | `either`), `evidence`
(`note`, `ref`), `attestedBy` (`membershipId`, `actorKind`, `label`, `at`), the due/started/completed times; plus `currentStepKey`,
`goLive` (`state`: `not_ready` | `awaiting_attestation` | `awaiting_approval` | `live` | `closed`, the latest `attestation`
with `expiresAt` while pending, `failedGuards`, `complianceOfficerMembershipId`) and `orgProfile` (`displayName`, `orgTimezone`).
**The tenant read never carries a ChartWarden operator's id.** Where an operator attested a step, approved the go-live or
revoked an attestation, the tenant sees `membershipId: null` / `approvedByMembershipId: null` and a label
(`attestedBy.label`, `approvedByLabel`, `revokedByLabel`: `"ChartWarden operations"`) with the time; reasons are kept. A
revocation by the tenant's own org_admin (see below) keeps its membership id. The platform read is unchanged
(`label` is null there). The tenant read is audited (`onboarding_task` list read). The older names stay as
aliases: `tasks` and `currentStep` (platform), `items`, `nextCursor` and `hasMore` (tenant; the whole wizard is one page).

### 2. New routes

| Route | Who | Guards |
|---|---|---|
| `POST /api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/attest` | platform ops | `onboarding.manage_platform`, step-up, no AI actor; body `evidenceNote`, `evidenceRef?`, `reason` |
| `POST /api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/reopen` | platform ops | same; body `reason` |
| `PATCH /api/v1/platform/tenants/{orgSlug}/org-profile` | platform ops | same; body `displayName?`, `orgTimezone?` (IANA) |
| `PUT /api/v1/platform/tenants/{orgSlug}/compliance-officer` | platform ops | same; body `membershipId` (an active member of that organization holding `compliance_officer`) and `reason` (8 to 500 characters; recorded with the operator in the audit trail) |
| `POST /api/v1/platform/tenants/{orgSlug}/go-live/approve` and `.../revoke` | platform ops | `go_live.approve_platform`, step-up, no AI actor; body `reason` |
| `POST /api/v1/tenant/onboarding/{taskId}/attest` and `/reopen` | the step's owner role | `onboarding.update`; no AI actor; `/reopen` body `reason` (8 to 1000 characters) is now **required** |
| `PATCH /api/v1/tenant/org-profile` | org_admin | `onboarding.manage_own` |
| `PUT /api/v1/tenant/compliance-officer` | org_admin | `onboarding.manage_own`, step-up |
| `POST /api/v1/tenant/go-live/attest` | compliance officer | `go_live.attest`, step-up; body `attestationConfirmed: true` |

`POST /api/v1/tenant/onboarding/{taskId}/complete` is now a deprecated alias of `/attest`: `evidenceNote` is required
(`422 ONBOARDING_EVIDENCE_REQUIRED`) and `completionEvidence` is ignored. `.../skip` now also refuses out of sequence and refuses
the go-live step.

`POST /api/v1/tenant/onboarding/{taskId}/start` and `/block` now also refuse an AI principal.

### 3. Changed behaviour

- **Go-live is two people, not two memberships.** The approver must be a different *person* than the attester: a platform
  operator who is also invited into the tenant as its compliance officer holds two memberships and is still one user, so
  the approval is refused `409 GO_LIVE_SAME_PERSON`. The database enforces it too (both user ids and both membership ids
  differ on an approved row).
- **An attestation must still stand at approval.** Approval is refused `409 GO_LIVE_ATTESTATION_STALE` (the `details` code is
  `attester_not_active`, `attester_not_compliance_officer` or `attester_not_assigned_officer`) when the attester is no longer an
  active member, no longer holds `compliance_officer`, or is no longer the assigned officer; and `409 GO_LIVE_ATTESTATION_EXPIRED`
  once it is more than 14 days old (a new attestation is refused the same way until platform operations revoke the old one).
  Reassigning the compliance officer voids a pending attestation by another officer automatically.
- **Compliance officer assignment** (both surfaces): the member must hold the `compliance_officer` role
  (`422 COMPLIANCE_OFFICER_LACKS_ROLE`); the officer can be changed while the tenant is `onboarding` or `active`, not while it is
  suspended or closing (`409 COMPLIANCE_OFFICER_LOCKED`).
- **Free text** (evidence note and reference, reasons, skip rationale, blocker reason, go-live note) is cleaned: a NUL character is
  `422 ONBOARDING_TEXT_INVALID`, other control characters except tab and newline are stripped, and text that looks like a Social
  Security or Medicare number is `422 EVIDENCE_LOOKS_LIKE_PHI` (the value is never echoed).

- `POST /api/v1/platform/tenants/{orgSlug}/status` with `toStatus: "active"` from `onboarding` is refused
  `409 GO_LIVE_TWO_PARTY_REQUIRED`. Approval refuses `409 GO_LIVE_NOT_ATTESTED` without a pending attestation and
  `409 ACTIVATION_GUARDS_FAILED` (the failed guards are in `details`) when a guard fails at approval time.
- `POST` and `PATCH /api/v1/platform/baa-register` now need `platform_tenant_baa.write_platform` and a fresh step-up.
- Typed refusals: `ONBOARDING_STEP_OUT_OF_ORDER`, `ONBOARDING_STEP_OWNER_MISMATCH` (403), `ONBOARDING_STEP_NOT_ATTESTABLE`,
  `ONBOARDING_STEP_ALREADY_SETTLED`, `ONBOARDING_EVIDENCE_REQUIRED` / `ONBOARDING_EVIDENCE_INVALID`, `TENANT_NOT_ONBOARDING`,
  `GO_LIVE_ALREADY_ATTESTED`, `GO_LIVE_NOT_ASSIGNED_OFFICER` (403), `GO_LIVE_SAME_PERSON`, `GO_LIVE_ATTESTATION_STALE`,
  `GO_LIVE_ATTESTATION_EXPIRED`, `GO_LIVE_PENDING`,
  `INVALID_ORG_TIMEZONE`, `COMPLIANCE_OFFICER_NOT_A_MEMBER`.

---

## 2026-10-06 — Discharge details the Medicare claim needs (place of death, receiving care setting)

**Why.** A Medicare hospice claim must report the patient discharge status (UB-04 FL 17 / 837I CL103,
CMS Pub. 100-04 Ch. 11 §30.3). For a death that status depends on **where the patient died**; for a transfer
to another hospice it depends on **where the receiving hospice cares for the patient**. ChartWarden now records
both and derives the claim codes from them. Requests that do not send them are refused with a specific error,
and records created before this change can be completed afterwards.

| Value sent | Claim patient status |
|---|---|
| `placeOfDeath: "home"` | 40 — expired at home |
| `placeOfDeath: "facility"` | 41 — expired in a medical facility (hospital, SNF, ICF, hospice facility) |
| `placeOfDeath: "unknown"` | 42 — expired, place unknown |
| `receivingCareSetting: "home"` | 50 — discharged to hospice, home |
| `receivingCareSetting: "facility"` | 51 — discharged to hospice, medical facility |

### 1. `POST /api/v1/admissions/{id}/discharge` — `placeOfDeath` required on a death

Required when `reason` is `"death"`; refused for any other reason. HL7-reported deaths that carry no place are
recorded as `"unknown"` (status 42).

```json
{
  "reason": "death",
  "dischargeDate": "2026-10-05",
  "narrative": "Patient expired peacefully with family present.",
  "deathCertifierId": "55555555-5555-4555-8555-555555555555",
  "placeOfDeath": "home"
}
```

Missing or invalid on a death — `422`:

```json
{
  "error": {
    "code": "PLACE_OF_DEATH_REQUIRED",
    "message": "placeOfDeath is required when reason is \"death\". Send \"home\", \"facility\" or \"unknown\": it sets the Medicare claim's patient discharge status (40 expired at home, 41 expired in a medical facility, 42 expired, place unknown — CMS Pub. 100-04 Ch. 11 §30.3). Without it the final claim cannot be billed. \"unknown\" is a valid answer when the place of death is not known.",
    "details": [{ "field": "placeOfDeath", "code": "PLACE_OF_DEATH_REQUIRED", "message": "…same text…" }],
    "correlationId": "…",
    "documentationUrl": "https://docs.chartwarden.app/errors/PLACE_OF_DEATH_REQUIRED"
  }
}
```

Sent with another reason — `422 PLACE_OF_DEATH_NOT_ALLOWED` ("placeOfDeath is only accepted when reason is
\"death\" (it sets claim patient status 40/41/42). Remove the field for any other discharge reason.").

### 2. `POST /api/v1/admissions/{id}/transfer-out` — `receivingCareSetting` required

```json
{
  "direction": "out",
  "effectiveDate": "2026-10-05",
  "otherHospiceName": "Desert Sun Hospice",
  "otherHospiceCcn": "031234",
  "receivingCareSetting": "facility",
  "narrative": "Family relocated; Desert Sun accepted the patient."
}
```

Missing or invalid — `422` (previously a generic `VALIDATION_FAILED`):

```json
{
  "error": {
    "code": "RECEIVING_CARE_SETTING_REQUIRED",
    "message": "receivingCareSetting is required on a transfer-out. Send \"home\" or \"facility\" — where the RECEIVING hospice will care for the patient: it sets the Medicare claim's patient discharge status (50 discharged to hospice, home; 51 discharged to hospice, medical facility — CMS Pub. 100-04 Ch. 11 §30.3). Without it the final claim cannot be billed.",
    "details": [{ "field": "receivingCareSetting", "code": "RECEIVING_CARE_SETTING_REQUIRED", "message": "…same text…" }]
  }
}
```

### 3. New — complete a death or transfer recorded without the detail

Deaths and transfer-outs recorded before this change have neither value, and their final claim is held by the
`bereavement_discharge_legitimacy` validation rule (defect `PLACE_OF_DEATH_MISSING` /
`RECEIVING_CARE_SETTING_MISSING`). Record the value on the existing record:

| Route | Permission | Body |
|---|---|---|
| `GET /api/v1/admissions/{id}/discharge-details` | `admission.read` + admission scope | — returns the completed discharge / transfer-out, their versions, and `missing` (`place_of_death`, `receiving_care_setting` or `null`) |
| `POST /api/v1/discharges/{dischargeEventId}/place-of-death` | `discharge.death` + scope on the owning admission | `{ "placeOfDeath": "facility", "ifVersion": 2 }` |
| `POST /api/v1/transfers/{transferEventId}/receiving-care-setting` | `transfer.out` + scope on the owning admission | `{ "receivingCareSetting": "home", "ifVersion": 0 }` |

Rules:

- `ifVersion` is the record version from the GET. A stale version → `409 VERSION_MISMATCH`.
- Filling a value that was never recorded needs nothing else. Replacing a recorded value needs
  `correctionReason` (20–2000 characters), stored with the change; without it →
  `409 DISCHARGE_DETAIL_CORRECTION_REASON_REQUIRED`. Sending the value already recorded is a no-op
  (`changed: false`).
- A place of death only on a **completed death** discharge; a care setting only on a transfer **out** —
  otherwise `422 DISCHARGE_DETAIL_NOT_APPLICABLE`.
- Success returns `{ id, admissionId, detail, value, previousValue, changed, version, claimPatientStatus }`.
  Each change publishes `m6.discharge.details_recorded`; billing re-validates the admission's open claims.

```json
POST /api/v1/discharges/cccccccc-cccc-4ccc-8ccc-cccccccccccc/place-of-death
{ "placeOfDeath": "home", "ifVersion": 3,
  "correctionReason": "Death certificate lists the residence, not the nursing facility." }
```

### 4. Claim reads and Type of Bill

- **Type of Bill.** A stay that ended by **revocation** or **transfer-out** now ends the claim cadence: the last
  claim is final **811/814**, no longer interim **812/813**. Re-validation updates unsubmitted claims
  automatically. Claims already **submitted** with 812/813 need a replacement (TOB 817,
  `POST /api/v1/billing/claims/{id}/replace`) once the MAC has accepted them; a claim in `partial_paid` or
  `denied` cannot be replaced in ChartWarden and must be adjusted with the MAC directly.
- `GET /api/v1/billing/claims` and `GET /api/v1/billing/claims/{id}` items carry an optional `attention` block:
  `stayEnd`, `typeOfBill { stored, derived, changed, remedy }` (`remedy`: `revalidate`,
  `await_acknowledgment`, `replace`, `manual`), `missingDischargeDetail` and `flags`.
- New list filter `?attention=missing_discharge_details` or `?attention=tob_changed` (scans up to 1,000 claims
  per request; follow `nextCursor`).
- Validation results' `remediation` is now stored flat (`summary`, `fixAction`, `fixDeepLink`, `observed`,
  `defects[]`) for both the initial and re-validation runs; older re-validation rows keep the nested
  `{ remediation, observed }` shape.
