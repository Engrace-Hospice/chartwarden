/**
 * WardenX — orders / prescribing / eMAR / IDG scenario data for the flagship patient (local dev).
 * NOT for production.
 *
 * Builds real M11 (Orders) / M12 (DoseSpot) / M13 (eMAR) / M14 (IDG) data for Eleanor Whitfield over
 * the real REST API, using the discipline personas from `seed-staff-personas.ts`.
 *
 * Genuine platform gaps hit and worked around/documented:
 *   - M14: there is NO REST route that creates an `idg_meeting` row (`POST /idg/recurring-policies`
 *     only creates a cadence *policy*; the schedule-materialization worker it defers to isn't
 *     registered anywhere in this codebase — confirmed by grepping the composition root). The
 *     project's own live-test suite (`apps/backend/__tests__/m14-idg-write.live.test.ts`) works
 *     around this by seeding one `idg_meeting` row directly at `status:'live'`; this script does the
 *     same, then drives agenda/attendance/decisions/adjourn through the real API from that point.
 *   - M14 (2nd gap, same root cause): `POST /idg/meetings/:id/packets/build` only flips
 *     `idg_meeting.status` — it does NOT insert into `idg_patient_packet` (that table is meant to be
 *     populated by the same unregistered background worker the meeting-creation gap above already
 *     documents; see `idg-route-service-db.ts`'s own header comment on `buildPackets`). Since the
 *     "IDG History" patient-chart tab (`GET /patients/:id/idg-history`) keys ENTIRELY on a packet row
 *     existing — not on the agenda item — driving agenda/attendance/decision/adjourn through the real
 *     API (as above) is not sufficient to make a reviewed patient show up there. This script closes
 *     that gap the same documented way: one `idg_patient_packet` row seeded directly. The
 *     `built_snapshot`/`discipline_views` JSONB values below are intentionally minimal placeholders,
 *     not a full `PacketSnapshot`/`DisciplineViewBlock` (packages/types/src/idg.ts) — no builder route
 *     exists to produce the real shape, and the History tab list itself never reads those fields
 *     (only the flat packet row + separately-queried decisions/action items).
 *   - M12: `medClass: "standard"` only — EPCS is hard-off in this environment
 *     (`sign-controlled/*` throws `EPCS_NOT_CERTIFIED` unconditionally), so no controlled-substance
 *     order is exercised here.
 *   - M11 cosign: the server RE-DERIVES the cosigner role from persisted drafter/kind facts rather
 *     than trusting the client — draft as `lpn` on a clinical kind (`lab`) to reliably trigger the
 *     `rn_case_manager`-cosign path from a different persona than the drafter.
 *
 * Idempotent: wipes prior orders/medication-orders/administrations/IDG data for this patient (+ the
 * one seeded meeting) via raw SQL before recreating.
 * Prereqs: bun run db:seed:staff, db:seed:scenario-admissions, db:seed:scenario-clinical (Whitfield
 * needs a care plan / signed problem for the IDG care_plan_update decision to reference, and M15
 * needs it to exist for the field-ops script; not a hard dependency here but sequenced this way).
 * Run:     bun run db:seed:scenario-orders-idg
 */
import { Client } from "pg";
import { ScenarioLog, findPatientIdByLastName, signIn } from "./lib/api-session";
import { firstRow } from "./lib/query-rows";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const LOCATION_MAIN_ID = "55555555-0000-4000-8000-000000000001"; // db:seed:org-structure
const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001"; // db:seed:org-structure
const nowIso = (): string => new Date().toISOString();

async function membershipIdFor(email: string): Promise<string> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  const r = await db.query<{ id: string }>(
    `SELECT m.id FROM membership m JOIN "user" u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
    [email],
  );
  await db.end();
  if (!r.rows[0]) throw new Error(`no membership found for ${email} — run db:seed:staff first`);
  return firstRow(r, "seed-scenario-orders-meds-idg: id lookup").id;
}

async function wipePriorOrdersMedsIdg(patientId: string): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");

  const orders = await db.query<{ id: string }>(
    "SELECT id FROM order_record WHERE patient_id = $1",
    [patientId],
  );
  const orderIds = orders.rows.map((r) => r.id);

  const meds = await db.query<{ id: string }>(
    "SELECT id FROM medication_order WHERE patient_id = $1",
    [patientId],
  );
  const medIds = meds.rows.map((r) => r.id);

  // `order_signature` is polymorphic (target_kind discriminates order_record vs medication_order),
  // so both id sets share the one cleanup.
  const allTargetIds = [...orderIds, ...medIds];
  if (allTargetIds.length) {
    await db.query("DELETE FROM order_signature WHERE target_id = ANY($1)", [allTargetIds]);
  }
  if (orderIds.length) {
    await db.query("DELETE FROM order_record WHERE id = ANY($1)", [orderIds]);
  }
  if (medIds.length) {
    await db.query("DELETE FROM administration_record WHERE medication_order_id = ANY($1)", [
      medIds,
    ]);
    await db.query("DELETE FROM medication_order WHERE id = ANY($1)", [medIds]);
  }

  // The one seeded IDG meeting (org-wide, not patient-scoped) — identified by a fixed marker in its
  // tenant_quorum_snapshot so re-runs find and replace only the one this script owns.
  const meetings = await db.query<{ id: string }>(
    `SELECT id FROM idg_meeting WHERE tenant_quorum_snapshot->>'seedMarker' = 'seed-scenario-orders-meds-idg'`,
  );
  const meetingIds = meetings.rows.map((r) => r.id);
  if (meetingIds.length) {
    await db.query("DELETE FROM idg_action_item WHERE idg_meeting_id = ANY($1)", [meetingIds]);
    await db.query("DELETE FROM idg_decision WHERE idg_meeting_id = ANY($1)", [meetingIds]);
    await db.query("DELETE FROM idg_agenda_item WHERE idg_meeting_id = ANY($1)", [meetingIds]);
    await db.query("DELETE FROM idg_attendance WHERE idg_meeting_id = ANY($1)", [meetingIds]);
    await db.query("DELETE FROM idg_minutes WHERE idg_meeting_id = ANY($1)", [meetingIds]);
    await db.query("DELETE FROM idg_patient_packet WHERE idg_meeting_id = ANY($1)", [meetingIds]);
    await db.query("DELETE FROM idg_meeting WHERE id = ANY($1)", [meetingIds]);
  }
  await db.end();
}

/** The documented M14 workaround: seed one `idg_meeting` row directly at status='live'. */
async function seedLiveIdgMeeting(
  organizationId: string,
  coordinatorMembershipId: string,
): Promise<string> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  const r = await db.query<{ id: string }>(
    `INSERT INTO idg_meeting
       (organization_id, location_id, scheduled_start, scheduled_end, status,
        coordinator_membership_id, tenant_quorum_snapshot)
     VALUES ($1,$2, now(), now() + interval '1 hour', 'live', $3, $4::jsonb)
     RETURNING id`,
    [
      organizationId,
      LOCATION_MAIN_ID,
      coordinatorMembershipId,
      JSON.stringify({ seedMarker: "seed-scenario-orders-meds-idg" }),
    ],
  );
  await db.end();
  return firstRow(r, "seed-scenario-orders-meds-idg: id lookup").id;
}

/**
 * The documented M14 workaround (2nd instance — see header comment): seed one `idg_patient_packet`
 * row directly, since no route inserts into this table. Without it, the patient-chart "IDG History"
 * tab shows "No IDG reviews yet" no matter how much of the real agenda/attendance/decision/adjourn
 * flow is driven through the API, because that read keys entirely on a packet row existing.
 */
async function seedIdgPatientPacket(
  organizationId: string,
  meetingId: string,
  patientId: string,
  admissionId: string,
): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  const builtAt = nowIso();
  const builtSnapshot = {
    schemaVersion: "2026-01-v1",
    meta: {
      meetingId,
      patientId,
      admissionId,
      locationId: LOCATION_MAIN_ID,
      builtAt,
      sinceCursorIso: builtAt,
      sinceContext: "first_idg",
      builderJobId: "seed-scenario-orders-meds-idg",
      appliedSudRedaction: false,
    },
    // No packet-builder route exists to produce the real since-last-IDG digests (see header
    // comment) — left as an intentionally empty placeholder, not fabricated clinical content.
    sinceLastIdg: {
      encounters: [],
      significantAssessmentChanges: [],
      j2051Triggers: [],
      ordersChanged: [],
      medicationsChanged: [],
      flaggedEvents: [],
    },
  };
  await db.query(
    `INSERT INTO idg_patient_packet
       (organization_id, provider_entity_id, location_id, idg_meeting_id, patient_id, admission_id,
        built_at, frozen_at, last_idg_reviewed_at, since_cursor_iso, built_snapshot, discipline_views,
        cover_summary_layer1)
     VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9, $10, $11::jsonb, $12::jsonb, $13)`,
    [
      organizationId,
      PROVIDER_ENTITY_ID,
      LOCATION_MAIN_ID,
      meetingId,
      patientId,
      admissionId,
      builtAt, // built_at
      builtAt, // frozen_at — same instant is a fine approximation for seed data
      builtAt, // last_idg_reviewed_at — stamped at adjournment (real system's own convention)
      builtAt, // since_cursor_iso
      JSON.stringify(builtSnapshot),
      JSON.stringify({}),
      "Reviewed by IDG — pain well-controlled on current regimen, no changes to level of care indicated.",
    ],
  );
  await db.end();
}

async function main(): Promise<void> {
  const rn = await signIn("rita@wardenx.local");
  const lpn = await signIn("dana@wardenx.local");
  const md = await signIn("drharris@wardenx.local");
  const msw = await signIn("mira@wardenx.local");
  const chaplain = await signIn("cole@wardenx.local");
  const log = new ScenarioLog("orders/meds/IDG (Whitfield)");

  const patientId = await findPatientIdByLastName(rn, "Whitfield");
  const cert = await rn.client.GET("/api/v1/patients/{patientId}/election-certification", {
    params: { path: { patientId } },
  });
  const admissionId = (cert.data as unknown as { admission?: { id?: string } } | undefined)
    ?.admission?.id;
  if (!admissionId)
    throw new Error("Whitfield has no admission — run db:seed:scenario-admissions first");

  console.log("wiping any prior orders/meds/IDG data for a clean re-run...");
  await wipePriorOrdersMedsIdg(patientId);

  // ── M11 — Orders (LPN-draft → RN-cosign → RN-sign path) ───────────────────────────────────────
  let signedOrderId: string | null = null;
  try {
    const draft = await lpn.client.POST("/api/v1/orders", {
      body: {
        patientId,
        admissionId,
        kind: "lab",
        drafterDiscipline: "lpn",
        // M11 `lab.v1`: LOINC-coded tests + the fasting flag are required before signature.
        data: {
          testCodes: [
            {
              system: "http://loinc.org",
              code: "24323-8",
              display: "Comprehensive metabolic panel",
            },
          ],
          fastingRequired: false,
          clinicalJustification: "Routine hospice labs",
        },
        orderingPhysicianMdmId: "11111111-0000-4000-8000-000000000001",
      },
    });
    const draftData = draft.data as unknown as { id: string } | undefined;
    if (draft.error || !draftData)
      throw new Error(`order draft failed: ${JSON.stringify(draft.error)}`);

    const reqSig = await lpn.client.POST("/api/v1/orders/{id}/request-signature", {
      params: { path: { id: draftData.id } },
      body: { signerDiscipline: "rn_case_manager" },
    });
    if (reqSig.error)
      throw new Error(`order request-signature failed: ${JSON.stringify(reqSig.error)}`);

    const cosign = await rn.client.POST("/api/v1/orders/{id}/cosign", {
      params: { path: { id: draftData.id } },
      body: {
        cosignerRole: "rn_case_manager",
        attestationText: "Reviewed and cosigned per LPN-draft policy for clinical order kinds.",
      },
    });
    if (cosign.error) throw new Error(`order cosign failed: ${JSON.stringify(cosign.error)}`);

    const sign = await rn.client.POST("/api/v1/orders/{id}/sign", {
      params: { path: { id: draftData.id } },
      body: { signerDiscipline: "rn_case_manager", signedAtClient: nowIso() },
    });
    if (sign.error) throw new Error(`order sign failed: ${JSON.stringify(sign.error)}`);
    signedOrderId = draftData.id;

    log.ok("Orders: LPN-drafted lab order, RN-cosigned, RN-signed");
  } catch (err) {
    log.fail(`M11 orders: ${String(err)}`);
  }
  void signedOrderId;

  // ── M11 — a SECOND order, deliberately left AWAITING SIGNATURE (#91) ──────────────────────────
  //
  // The order above is driven all the way to `signed`, which is the right shape for a chart but leaves
  // M11's Signature Inbox — the queue four of its seven screens are built around — permanently EMPTY on
  // a seeded stack. An E2E spec written against that seed can only assert the empty state, which is the
  // exact failure #106/F-046 names in the billing spec: a test that passes because there is nothing to
  // act on tells you nothing about whether acting works.
  //
  // Same LPN-draft → RN-cosign path, stopping one step short. The §2.5 cosignature is ATTACHED (an
  // LPN-drafted clinical order requires one before it can be signed), so the row the inbox renders is
  // genuinely signable rather than one that would 409 on the ceremony the queue offers.
  try {
    const draft = await lpn.client.POST("/api/v1/orders", {
      body: {
        patientId,
        admissionId,
        kind: "dme",
        drafterDiscipline: "lpn",
        data: {
          itemDescription: "Hospital bed with trapeze bar",
          reason: "Patient no longer able to transfer independently",
        },
        orderingPhysicianMdmId: "11111111-0000-4000-8000-000000000001",
      },
    });
    const draftData = draft.data as unknown as { id: string } | undefined;
    if (draft.error || !draftData)
      throw new Error(`pending-signature draft failed: ${JSON.stringify(draft.error)}`);

    const reqSig = await lpn.client.POST("/api/v1/orders/{id}/request-signature", {
      params: { path: { id: draftData.id } },
      body: { signerDiscipline: "rn_case_manager" },
    });
    if (reqSig.error)
      throw new Error(`pending-signature request failed: ${JSON.stringify(reqSig.error)}`);

    const cosign = await rn.client.POST("/api/v1/orders/{id}/cosign", {
      params: { path: { id: draftData.id } },
      body: {
        cosignerRole: "rn_case_manager",
        attestationText:
          "Reviewed the LPN-drafted DME request against the current plan of care and cosigned it.",
      },
    });
    if (cosign.error)
      throw new Error(`pending-signature cosign failed: ${JSON.stringify(cosign.error)}`);

    log.ok("Orders: a second DME order left AWAITING SIGNATURE (the inbox has something to sign)");
  } catch (err) {
    log.fail(`M11 pending-signature order: ${String(err)}`);
  }

  // ── M12 — DoseSpot (standard medication order, no EPCS) ───────────────────────────────────────
  let signedMedOrderId: string | null = null;
  try {
    const draft = await md.client.POST("/api/v1/medication-orders", {
      body: {
        patientId,
        admissionId,
        medClass: "standard",
        rxnormRxcui: "197696",
        ndc: null,
        drugName: "Morphine sulfate oral solution",
        strength: "20 mg/mL",
        doseForm: "solution",
        route: "oral",
        // `StandardMedOrderData`: a structured sig beside its free text, plus dispense terms.
        data: {
          sigStructured: {
            doseQuantity: 0.25,
            doseUnit: "mL",
            route: "oral",
            frequencyCode: "Q2H",
            asNeeded: true,
            asNeededReasonCode: "pain",
          },
          sigFreeText: "0.25-0.5 mL PO every 2 hours PRN pain or dyspnea",
          indication: "Pain or dyspnea at end of life",
          refillsAuthorized: 0,
          dispenseQuantity: { value: 30, unit: "mL" },
          daysSupply: 14,
          daw: false,
        },
        prescriberDiscipline: "hospice_physician",
        prescribingPhysicianMdmId: "11111111-0000-4000-8000-000000000001",
        refillsAuthorized: 0,
      },
    });
    const draftData = draft.data as unknown as { id: string } | undefined;
    if (draft.error || !draftData)
      throw new Error(`medication order draft failed: ${JSON.stringify(draft.error)}`);

    await md.client.POST("/api/v1/medication-orders/{id}/request-signature", {
      params: { path: { id: draftData.id } },
      body: { signerDiscipline: "hospice_physician" },
    });

    const sign = await md.client.POST("/api/v1/medication-orders/{id}/sign", {
      params: { path: { id: draftData.id } },
      body: {
        signerDiscipline: "hospice_physician",
        signedAtClient: nowIso(),
        signerIsOrderingPhysician: true,
      },
    });
    if (sign.error) throw new Error(`medication order sign failed: ${JSON.stringify(sign.error)}`);
    signedMedOrderId = draftData.id;

    // F-058 — the signature ACTIVATES this order, because `dosespot_send_state` is `not_required`:
    // nothing is being e-prescribed, so there is no NewRx to send and no pharmacy ack to wait for. It
    // used to stop at `signed`, where it was invisible to `/medications/active`, refused by M13's D6
    // administrability gate, and impossible to complete or discontinue.
    log.ok("DoseSpot: standard comfort-medication order drafted + signed → active (no EPCS)");
  } catch (err) {
    log.fail(`M12 DoseSpot: ${String(err)}`);
  }

  // ── M13 — eMAR (administration against the now-ACTIVE standard medication order) ──────────────
  try {
    if (!signedMedOrderId) throw new Error("no signed medication order to administer against");
    const admin = await rn.client.POST("/api/v1/administrations", {
      body: {
        medicationOrderId: signedMedOrderId,
        medClass: "standard",
        mode: "single_dose",
        administeredAt: nowIso(),
        data: { route: "oral", administeredAmount: 0.25, administeredUnit: "mL" },
        notes: "Patient reported pain 5/10; administered per PRN order, reassessed at 30 minutes.",
      },
    });
    if (admin.error)
      throw new Error(`administration record failed: ${JSON.stringify(admin.error)}`);
    log.ok("eMAR: one PRN administration recorded (standard med, no witness token needed)");
  } catch (err) {
    log.fail(`M13 eMAR: ${String(err)}`);
  }

  // ── M14 — IDG (documented gap: meeting seeded directly, rest driven via real API) ─────────────
  try {
    const orgId = rn.organizationId;
    const coordinatorId = await membershipIdFor("rita@wardenx.local");
    const meetingId = await seedLiveIdgMeeting(orgId, coordinatorId);

    const agenda = await rn.client.POST("/api/v1/idg/meetings/{id}/agenda", {
      params: { path: { id: meetingId } },
      body: {
        kind: "patient_review",
        patientId,
        noteText: "Routine IDG review — RHC, stable symptom burden.",
      },
    });
    if (agenda.error) throw new Error(`agenda item failed: ${JSON.stringify(agenda.error)}`);

    // Documented DB-direct workaround #2 (see header comment) — without this, the patient-chart
    // "IDG History" tab shows "No IDG reviews yet" regardless of agenda/decision/adjourn below.
    await seedIdgPatientPacket(orgId, meetingId, patientId, admissionId);

    const attendees: Array<{ email: string; membershipId: string; discipline: string }> = [
      { email: "rita@wardenx.local", membershipId: coordinatorId, discipline: "rn_case_manager" },
      {
        email: "mira@wardenx.local",
        membershipId: await membershipIdFor("mira@wardenx.local"),
        discipline: "msw",
      },
      {
        email: "cole@wardenx.local",
        membershipId: await membershipIdFor("cole@wardenx.local"),
        discipline: "chaplain",
      },
      {
        email: "drharris@wardenx.local",
        membershipId: await membershipIdFor("drharris@wardenx.local"),
        discipline: "hospice_physician",
      },
    ];
    for (const a of attendees) {
      await rn.client.POST("/api/v1/idg/meetings/{id}/attendance", {
        params: { path: { id: meetingId } },
        body: { membershipId: a.membershipId, discipline: a.discipline, status: "present" },
      });
    }

    const decision = await rn.client.POST("/api/v1/idg/meetings/{id}/decisions", {
      params: { path: { id: meetingId } },
      body: {
        patientId,
        payload: {
          kind: "team_note",
          noteText:
            "IDG reviewed Ms. Whitfield's plan of care: pain well-controlled on current regimen, " +
            "no changes to level of care indicated at this time. Continue routine home care.",
        },
      },
    });
    if (decision.error)
      throw new Error(`decision record failed: ${JSON.stringify(decision.error)}`);

    // F-081 — THE MEETING IS LEFT IN SESSION, DELIBERATELY. This script used to adjourn it here, via
    // `grantFreshStepUp` (a DB-direct stamp of `session.last_step_up_at`, because no script can perform
    // a WebAuthn or TOTP ceremony). That left a seeded stack whose only IDG meeting was already at its
    // terminal state, so the §2.2 D13 commit point — the one write in M14 that matters, the one that
    // emits every open decision, freezes the packets and resets the 42 CFR 418.56(d) 15-day review
    // floor — had nothing left to act on and no browser test could ever drive it. Same shape as
    // #106/F-046 (a queue whose only seeded row is terminal) and as the EVV device roster this pass
    // already fixed.
    //
    // It is drivable NOW because step-up itself is: `e2e/specs/idg.spec.ts` enrols a passkey through
    // the real `/security/passkeys` screen and completes the real `/step-up` ceremony. Three defects
    // stood in the way of that and are fixed (the passkey origin, `passkey.name` NOT NULL, and a
    // WebAuthn challenge that was compared in a different encoding than it was signed in), which is
    // why this shortcut can be retired rather than merely moved.
    log.ok(
      "IDG: meeting + packet seeded (documented DB-direct workarounds), quorate attendance, 1 decision, LEFT IN SESSION for the D13 adjourn ceremony (see F-081)",
    );
  } catch (err) {
    log.fail(`M14 IDG: ${String(err)}`);
  }

  log.summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
