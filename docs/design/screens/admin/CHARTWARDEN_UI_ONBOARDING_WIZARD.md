# CHARTWARDEN_UI_ONBOARDING_WIZARD

Version: 2.0
Status: Screen Specification
Module: Tenant Onboarding Wizard (M34)

---

## Purpose

The Onboarding Wizard takes a new organization from provisioning to go-live in one fixed order, with every
step saved as it is done, so an operator (or the tenant's admin) can stop and resume. It enforces the
compliance gates (BAA executed, every required step settled, two people for go-live) that must hold before a
tenant becomes active.

Two surfaces share one wizard and one set of rules, all enforced by the server:

- **Platform operations** (`apps/admin`, `/tenants/:orgSlug/onboarding[/:stepKey]`): drives any step on the
  tenant's behalf, with a recorded reason.
- **The tenant** (`apps/web`, `/admin/onboarding`): the org admin and the compliance officer settle the
  steps they own.

---

## Primary Users

- ChartWarden Platform Operator (the `platform_ops` role)
- Tenant Admin (`org_admin`)
- Compliance Officer (attests go-live readiness)

---

## Layout Pattern

Use Stepper Workflow.

```text
Page head (tenant · done of total steps · lifecycle status)        [Back to tenant]
Left: Step rail (every step, in order)  |  Right: the open step
                                          - what the step is, who owns it, why it is read-only
                                          - the facts that settle it
                                          - the step's own data (list + form)
                                          - how it was settled (evidence, who, when)
                                          - actions: mark done with evidence · skip · re-open
```

Below 768px the rail becomes a horizontal scroller above the step. A step is a deep link
(`/onboarding/:stepKey`); the bare route resumes at the first step that is not settled.

---

## Steps (the platform's fixed order)

| # | Step | Owner | Settles |
|---|------|-------|---------|
| 1 | Organisation (display name, time zone) | Operator | attested with evidence |
| 2 | Plan and contract (census-banded plan, billing service) | Operator | signing the contract |
| 3 | BAA (record, signed agreement upload, dates) | Operator | automatic: latest BAA executed, document linked, more than 90 days left |
| 4 | Provisioning | Operator | automatic: the platform builds the tenant |
| 5 | Provider entity and NPI (CCN, NPI, EIN) | Operator or tenant | attested with evidence |
| 6 | Locations (at least one primary) | Tenant admin | automatic once a primary location exists, else attested |
| 7 | Billing: clearinghouse (Stedi, Claim.MD or outside) | Operator or tenant | automatic once the choice is settled, else attested |
| 8 | Billing: MAC credentials | Operator or tenant | automatic once a credential exists, else attested; skipped automatically under "outside" |
| 9 | Billing: payer enrollment | Operator or tenant | attested with evidence; skipped automatically under "outside" |
| 10 | e-Prescribing (DoseSpot) | Operator or tenant | automatic once the tenant's DoseSpot configuration is active, else attested |
| 11 | People: first admin | Operator | automatic: the first admin accepted their invitation |
| 12 | People: compliance officer | Operator or tenant | an officer is assigned |
| 13 | Sample data (optional) | Operator | attested; does not gate later steps |
| 14 | Go-live | Compliance officer, then Operator | the two-party approval; never attested or skipped |

A step is **locked** until every earlier required step is done or skipped (the server refuses an out-of-order
write with 409 and names the step to finish first). Locked steps can be read. Data entered for an earlier step stays
editable; editing it while a go-live attestation is pending voids that attestation.

A step is **skipped** only where it does not apply: MAC, payer enrollment, DoseSpot and sample data. Every other
step is settled by evidence or by its own facts.

### Step 3: BAA, the signed agreement

The operator records the BAA (addendum version, status, dates) and uploads the signed agreement in the same form. The form has a file chooser
("Signed agreement", PDF, JPEG, PNG, TIFF or Word, at most 10 MB) in place of the document id the step used to take. The panel refuses a file of
another type, an empty one and an oversized one before any request; the server checks again and its word counts. Choosing a file does not send
it: "Upload agreement" asks for a reason (a fresh step-up, an Idempotency-Key, a reason, an operator that is not an AI principal), then the platform
files the document with the tenant's own documents under the one BAA kind and answers its id, and the form says "Uploaded <file>. Save the BAA to
link it to this record." Saving the BAA then records it with that id, as before; an executed BAA without a document is refused in the form
("upload it first"). A record that already has a document says so and keeps it unless a file is chosen to replace it.

The upload is its own permission (not the general documents upload: it files this one kind for the tenant in the path, and reads or lists no
document), held by `platform_ops` alone, and is accepted only while the tenant is provisioning or onboarding. It counts as a data write: a pending
go-live attestation is voided by it. A step-up that has gone stale offers Re-verify; the typed form comes back, the chosen file does not (it cannot
survive leaving the page), so the file is chosen again. A server refusal of the file (type or content mismatch, size, a scanner verdict, no object
store) is shown in the reason prompt, which stays open, and nothing is linked.

**Open items (step 3).** An object the store holds for a document whose commit did NOT land is never deleted by the upload itself:
after a COMMIT that may have succeeded the object is kept and the failure logged, because deleting the file of a document that exists
would lose the signed agreement. "May have succeeded" means the commit failed without a refusal the database answered with a definite
error class: a socket or connection loss, or a connection-class or server-error SQLSTATE (08xxx, 57P0x, 40003, 58xxx, XXxxx), leaves the
outcome unknown; a refusal with any other SQLSTATE (a serialization failure, a deferred constraint) is a rollback and the object is removed.
The generic `createDocument` and `createVersion` paths of every tenant upload share this rule (it is the documents module's, not the BAA's).
Removing an object is best effort and bounded (a store that does not answer cannot hold the transaction), so an orphan object is possible
until a sweep exists: a sweep that reclaims one (an object in a tenant bucket that no `document_version` row names) is not built; there is
no ADR for the BAA upload yet, so this is recorded here until the decision gets its number.

### Step 7: Billing: clearinghouse

The operator chooses Stedi, Claim.MD or billing outside ChartWarden for the tenant (a change of vendor or mode starts the
new configuration at draft and voids the vendor BAA when the vendor changes; the dialog says so before it is confirmed).
The vendor credential is write-only: sealed under the tenant's key, never returned or shown, never carried through a
Re-verify. A change resumed after a Re-verify is still pinned to the version the operator first read (never re-read), so a
change made meanwhile is a 412 that reloads the record. A server refusal of the credential or the evidence note sits under
that input, with the prompt out of the way and what was typed kept. Billing outside takes no mode and no credential, and its
dialog says only what is true of this tenant: ChartWarden transmits nothing; during onboarding steps 8 and 9 are skipped;
and where a contract is signed its billing service mode is set to none now (onboarding) or from the 1st of next month
(a live tenant); with no contract it says nothing about the mode. The system sets the mode and attributes it, in the platform
audit row, to whoever set it off (the tenant, an operator, or the hourly sweep that applies it again).

Billing outside is an invariant: a tenant that bills outside is on mode none, an operator cannot set another mode on it (409), and the
tenant itself cannot move off outside while it has a contract (409): only an operator can, in this step. When the operator moves a
tenant with a signed contract from outside to a vendor, the form asks for a **Billing service mode** (None, Billing software or
Managed billing; no default, and None is an explicit choice to keep the tenant unbilled), says what it will do (set before the
clearinghouse, put back to none if the clearinghouse change fails, dated now while onboarding), and sends it with the choice. Nothing
is asked for a first choice, a vendor-to-vendor change or a tenant with no contract, and the server's own refusal of the field is shown.
A stale pin (412) or a missing one (428) closes the form and the prompt, reloads the record and says so.

Whether the choose form asks for the mode is the **server's** answer: the clearinghouse read carries `hasContract` (a contract that is not
canceled, live or paused), and the panel never infers it from the Plan and contract step. A live tenant is not moved here (step 7 is
read-only once the tenant is active): the tenant hub's clearinghouse card offers **Switch to a vendor** for a live tenant that bills
outside and holds a contract. It reuses the choose form (Claim.MD or Stedi only) with the mode pick (no default; None is an explicit
choice), says the mode takes effect from the 1st of next month, and sends one pinned write that sets the mode and the vendor together;
the operator's write for that switch is accepted while the tenant is provisioning, onboarding, active, at risk or suspended (any other
status is refused, 409, before a mode is written) and needs the pricing key as well.

A vendor is then walked to active, each fact shown as met or not yet:

1. the credential is on file;
2. the tenant recorded its vendor BAA (in its own settings; the operator cannot);
3. an operator verified the BAA (its own permission). The write is **pinned to the record the operator read**: the
   prompt shows the document, the effective date and when the tenant recorded it, and `If-Match` is that record's
   `recordedAt`. A BAA the tenant re-recorded meanwhile re-reads the record, shows the new one under a notice that it
   changed, and needs a second, deliberate confirm (never an automatic retry). A BAA already verified by someone else
   closes the prompt;
4. the connection is verified: a no-patient connection test for Claim.MD (a rejected credential or an unreachable vendor is
   said in words and nothing is marked verified), an attestation for Stedi (what was checked and by whom, and the
   operator's own confirmation that the note names no patient);
5. the clearinghouse is activated, offered only once the connection and the BAA are both verified (otherwise the panel says
   which is missing).

When a vendor is chosen but the contract's billing service mode is still **None** (outside billing sets it; a later vendor
choice never moves it back, because the mode is a commercial term), a banner says so and links to the Plan and contract
step. It reads the contract, an audited read, so it appears only where a vendor is chosen.

### Steps 8 and 9 under "outside"

When the SYSTEM skipped a step because the tenant bills outside ChartWarden, the rail says "Skipped automatically" and the
step shows why it does not apply, with none of its own forms. The server's `systemSkipped` flag decides this, never the
rationale text (a person can type the same words on a skip of their own, which keeps the step's own panel). If the tenant
has since chosen a vendor the step applies again: the server re-opens it by itself, unless a go-live attestation is pending,
so the panel says so and how to get it back (revoke the attestation, then re-open the step).

---

## Tenant Lifecycle

`signup_intent` → `provisioning` → `onboarding` → `active` → (`suspended` / `at_risk`) → `offboarding_initiated` →
`final_export_pending` → `retained` → `destruction_pending` → `destroyed`.

The wizard is read-only while the tenant is provisioning and once it is active. `onboarding` to `active` is not a
status an operator applies: it is the go-live approval below (the status route answers 409).

---

## Go-Live (two people)

1. The tenant's compliance officer attests readiness (fresh step-up) in the tenant app. An attestation is
   approvable for 14 days.
2. A **different** platform operator approves (fresh step-up, a reason). Approval re-judges the activation guards at
   that instant (every required step settled, BAA executed, BAA more than 90 days from expiry) and lists every one that
   fails. The operator who recorded the BAA cannot approve. The tenant then goes active and its organization opens.
3. A pending attestation can be revoked (with a reason); the officer attests again. Any data change while it is pending
   revokes it automatically.

Panel states: not ready (what is still open, each a link), awaiting the officer, awaiting approval (approve or
revoke; an expired attestation can only be revoked), live (approved by, why), closed.

---

## Writes by the operator

Every write needs a fresh step-up and is refused for an AI principal. A refused step-up offers Re-verify and carries
the typed form through it (never a credential or a write-only value). Each write carries a reason (8 to 500 or
1000 characters, counted after whitespace is collapsed) that is recorded in the audit trail the tenant can read. A
data write carries one Idempotency-Key per attempt, renewed by any answer (the server caches a refusal under the key).
A credential update is pinned to the version the operator read (If-Match); a stale pin reloads the record.

---

## Tenant surface: billing and e-prescribing panels (steps 7, 8 and 10)

The tenant's own wizard (`apps/web`, `/admin/onboarding/:stepKey`) draws these panels inside the same step frame as every
other step: the frame owns the heading, the owner, why a step is read-only, how it was settled, and Start / Mark done with
evidence / Re-open / **This does not apply to us** (steps 8, 9 and 10 only; the organization administrator, with a rationale and
a fresh step-up). A panel owns only what its step edits, and reads the step view, the held permission keys and the role keys the
shell hands it. Nothing here is operator wording: "your organization", "ChartWarden".

| Step | Panel | Tenant calls | Keys | Settles |
|------|-------|--------------|------|---------|
| 7 Billing: clearinghouse | choose, BAA, connection, activation | `GET` / `PUT /api/v1/tenant/clearinghouse`, `POST` `.../baa`, `.../verify`, `.../activate` | `billing.clearinghouse.read` / `.admin` | the server, when the clearinghouse is active (or the choice is billing outside ChartWarden); the frame offers no Mark done |
| 8 Billing: MAC credentials | list, add, replace, test | `GET` / `POST /api/v1/billing/mac-credentials`, `POST` `.../{providerEntityId}/test`, `GET /api/v1/provider-entities` | `billing.mac_credential.read` / `.admin`, `org.manage` | the member marks it done with evidence, or skips it |
| 10 e-Prescribing (DoseSpot) | what the kickoff is, an empty registration seam | none | none | the member marks it done with evidence, or skips it |

Step 7. The first choice carries no `If-Match`; a change carries the `version` the member read, and a 412 or 428 closes the
form, reloads the record and says so. Billing outside takes no mode and no credential, and says "ChartWarden will not send
claims; steps 8 and 9 are skipped." A tenant cannot change its billing service mode: moving off outside while a contract exists is
refused (409) and the panel says to ask ChartWarden. The vendor credential is write-only and is never stashed through a Re-verify;
the choice, its mode and its pinned version are, in memory only. The BAA is recorded by the organization (where it is kept and
its effective date), then the panel says it is **waiting for ChartWarden to verify** it, and the activation button appears only
once the connection and the BAA are both verified. Claim.MD runs a no-patient connection test; Stedi has none, so the member
attests what was checked and confirms the note names no patient.

Step 8. The client secret is write-only, entered again on every save, and never stashed. A replacement is pinned to the version
the member read (`If-Match`; a stale pin is a 409 `STALE_VERSION` that reloads the list). Test probes the MAC portal and says in
words whether it answered.

Step 10. In this tree step 10 is an ordinary step: the panel is DoseSpot copy plus one named seam, `DoseSpotRegistrationSlot`,
that renders nothing. It calls no API and checks no DoseSpot permission key, and it never assumes how the step settles, so the
DoseSpot branch (clinic registration, prescriber enrolment, a fact that settles the step by itself) fills the seam later without
rework here.

Every write on these panels needs a fresh step-up (Re-verify keeps what was typed, never a credential), is refused for an AI
principal, and carries one Idempotency-Key per intent, kept across a request that got no answer and renewed by any answer. The
onboarding view is audited per read, so a panel reloads it once per finished write, never on a timer.

---

## Empty, Loading and Error States

- Loading: a spinner naming the thing being loaded; a step panel loads its own data.
- No data yet: an honest sentence and the one action that creates it ("No location yet", "No published plan to sign").
- Refused: the server's reason in plain words, with the next step (Re-verify, go to the earlier step, fix the field,
  reload the record that changed).
- Unreachable: a retryable message; a reference id for support when the failure is not the operator's doing.

---

## Actions

- Mark a step done with evidence (what was checked and by whom, an optional reference, a reason)
- Skip a step that does not apply (reason)
- Re-open a settled step to edit (reason; refused while a go-live attestation is pending)
- Save a step's data (provider entity, location, MAC credential, BAA, organisation profile)
- Upload the signed BAA for the tenant (a reason; the document id then goes on the BAA record)
- Sign the contract; change the billing service
- Assign the compliance officer
- Approve go-live; revoke a go-live attestation
