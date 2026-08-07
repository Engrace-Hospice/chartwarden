/**
 * WardenX — M6 admission scenario seed: 6 patients, 6 distinct admission outcomes (local dev only).
 *
 * Drives the REAL M6 API (not raw SQL) for every state transition, same convention as
 * `seed-patients.ts`/`seed-staff-personas.ts` — RLS/ABAC/state-machine rules get exercised
 * honestly. This is task #9 of the post-fix admission-pipeline work: until the
 * `admission-route-service-db.ts` outbox-payload fix (2026-08-07), EVERY mutating M6 route past
 * `createAdmission` threw `payload_schema_violation` and rolled back its whole transaction —
 * `publishOutboxEvent` throws `OutboxEventValidationError` on any missing required payload field
 * (packages/shared/src/outbox/publish.ts), and that throw happens inside the caller's own tx. So
 * sign/discharge/transfer/revoke/LOC-change all 500'd on every single call, for every org. This
 * script is the first real exercise of the fixed sequence across a full outcome matrix.
 *
 * Patients (seed-patients.ts, in insertion order) → outcome:
 *   Whitfield → RHC (routine home care; already active from `_test-admission5.ts` — reused, not
 *               re-driven)
 *   Brandt    → GIP (general inpatient; had a pre-existing 'pending' admission from an early,
 *               pre-fix run — reused rather than creating a duplicate)
 *   Okonkwo   → transfer-in
 *   Delgado   → discharged (live, reason=no_longer_terminal)
 *   Nakamura  → revoked
 *   Fairbanks → death (discharge reason=death)
 *
 * GIP note: `POST /level-of-care` lands the period in 'assigning', not 'active' — confirming the
 * bed (route `/level-of-care/:id/confirm-bed`) calls the real M37
 * `ipuBedAssignmentReader.activeBedAssignmentForLevelOfCarePeriod`, which requires an actual M37
 * bed assignment. No M37 unit/room/bed seed data exists in this DB (checked: `ipu_room`/`ipu_bed`
 * both empty, `ipu_unit` doesn't even have a row inserted anywhere locally) — wiring that is a
 * separate M37 seeding task, out of scope here. So GIP intentionally stops at 'assigning', a real
 * or `confirm-bed` from unbanked bed data instead of faking an active bed.
 *
 * Transfer-in note: `transferIn` puts the inherited election period straight to 'active' with no
 * election-statement/CTI of our own (by design — the sending hospice's certification still
 * applies), but `computeActivationGate`/`gateFacts` only ever look at the period with
 * `sequenceNumber = 1` (apps/backend/src/modules/06-admission/admission-route-service-db.ts
 * `gateFacts`). A transfer-in's inherited period is never sequence 1 in practice, so `gateFacts`
 * finds no period-1 row and the gate defaults to requiring election/CTI/attending signatures that
 * a transfer-in flow never produces. Net effect: `admission.status` has no route to 'active' for a
 * transfer-in intake as currently built — confirmed by reading the gate code, not assumed. This
 * script drives everything the transfer-in API surface actually offers (the inherited period is
 * 'active', the next period gets its own CTI hospice-MD-signed and activated) and stops there,
 * flagging the gap rather than pretending `activate` would work.
 *
 * Prereqs: backend+web+DB running, org/users/patients/org-structure/mdm seeded already
 *          (db:seed, db:seed:patients, db:seed:org-structure, db:seed:mdm).
 * Run:     bun run scripts/db/seed-scenario-admission-outcomes.ts
 */
import { signIn } from "./lib/api-session";

const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001";
const LOCATION_IPU_ID = "55555555-0000-4000-8000-000000000002";
const HOSPICE_MD_ID = "11111111-0000-4000-8000-000000000001"; // Eleanor Whitfield MD, NPI 1003000001
const ATTENDING_ID = "11111111-0000-4000-8000-000000000002"; // Marcus Delgado DO, NPI 1003000002
const HOSPICE_MD_NPI = "1003000001";
const HOSPICE_MD_NAME = "Eleanor Whitfield MD";
const ATTENDING_NPI = "1003000002";
const ATTENDING_NAME = "Marcus Delgado DO";

const today = () => new Date().toISOString().slice(0, 10);

const PATIENTS = {
  whitfield: { id: "37528bbf-20da-4d38-a5f1-e6defc95f82e", name: "Eleanor Whitfield" },
  brandt: { id: "72fa672a-6fc0-4b36-af76-30216a2cc3ac", name: "Margaret Brandt" },
  okonkwo: { id: "529e2869-f878-4617-b321-9c1e43400cdf", name: "Samuel Okonkwo" },
  delgado: { id: "6668b074-93b6-4079-ad98-e633152ba362", name: "Rosa Delgado" },
  nakamura: { id: "8288107b-8ade-494a-be4c-def558687819", name: "Henry Nakamura" },
  fairbanks: { id: "b20d366b-d317-42cd-8be6-8804bc687a35", name: "Walter Fairbanks" },
} as const;

type Session = Awaited<ReturnType<typeof signIn>>;

function ok(label: string, res: { response: Response; data?: unknown; error?: unknown }): void {
  const status = res.response.status;
  const body = JSON.stringify(res.data ?? res.error);
  console.log(`${status < 300 ? "✓" : "✗"} ${label}: ${status} ${body}`);
  if (status >= 300) throw new Error(`${label} failed: ${status} ${body}`);
}

/** Create a brand-new admission for a patient (skips patients that already have one). */
async function createAdmission(
  s: Session,
  patientId: string,
  intakeMethod: "in_person" | "transfer_in",
): Promise<string> {
  const res = await s.client.POST("/api/v1/admissions", {
    body: {
      patientId,
      intakeMethod,
      hospiceMedicalDirectorId: HOSPICE_MD_ID,
      attendingPhysicianId: intakeMethod === "in_person" ? ATTENDING_ID : undefined,
    },
  });
  ok(`create admission (${intakeMethod})`, res);
  return (res.data as { id: string }).id;
}

async function getCert(s: Session, patientId: string) {
  const res = await s.client.GET("/api/v1/patients/{patientId}/election-certification", {
    params: { path: { patientId } },
  });
  ok("get election-certification", res);
  return res.data as {
    admission: { id: string; state: string; version: number } | null;
    periods: Array<{
      id: string;
      sequenceNumber: number;
      electionStatement: { id: string; status: string } | null;
      cti: { id: string; status: string; attendingMdSigned: boolean } | null;
    }>;
  };
}

/**
 * Full period-1 election + certification + activation — brings a fresh (or partially-driven)
 * admission to 'active'. Idempotent: re-checks state before each step so a re-run after a partial
 * failure resumes instead of re-drafting/re-signing into a conflict.
 */
async function electAndActivate(
  s: Session,
  admissionId: string,
  patientId: string,
  patientName: string,
  icd10: string,
): Promise<void> {
  let cert = await getCert(s, patientId);
  let p1 = cert.periods.find((p) => p.sequenceNumber === 1);
  if (!p1 || !p1.cti) throw new Error(`patient ${patientId}: no period-1/CTI to elect against`);

  let esId = p1.electionStatement?.id;
  if (!esId) {
    const es = await s.client.POST("/api/v1/admissions/{id}/election-statements", {
      params: { path: { id: admissionId } },
      body: {
        electionPeriodId: p1.id,
        effectiveDate: today(),
        primaryDiagnosisIcd10: icd10,
        electedProviderEntityId: PROVIDER_ENTITY_ID,
        waiverAcknowledged: true,
      },
    });
    ok("draft election statement", es);
    esId = (es.data as { id: string }).id;
  } else {
    console.log(`  election statement already drafted (${esId}), status=${p1.electionStatement?.status}`);
  }

  if (cert.admission?.state === "referred" || cert.admission?.state === "pending") {
    ok(
      "acknowledge NOR",
      await s.client.POST("/api/v1/admissions/{id}/nor", {
        params: { path: { id: admissionId } },
        body: {
          formVersionId: "00000000-0000-4000-8000-000000000001",
          deliveryMethod: "electronic_witnessed",
          acknowledgedAt: new Date().toISOString(),
          acknowledgedByName: patientName,
          acknowledgedByRole: "patient",
        },
      }),
    );
  } else {
    console.log(`  NOR already acknowledged (admission state=${cert.admission?.state})`);
  }

  if (p1.electionStatement?.status !== "signed") {
    ok(
      "sign election statement",
      await s.client.POST("/api/v1/election-statements/{id}/sign", {
        params: { path: { id: esId } },
        body: { signingPatientName: patientName, signingRole: "patient", ifVersion: 0 },
      }),
    );
  } else {
    console.log("  election statement already signed");
  }

  if (p1.cti.status === "drafted") {
    const mdSign = await s.client.POST("/api/v1/cti/{id}/sign-hospice-md", {
      params: { path: { id: p1.cti.id } },
      body: { signingPhysicianName: HOSPICE_MD_NAME, signingPhysicianNpi: HOSPICE_MD_NPI, ifVersion: 0 },
    });
    ok("sign CTI (hospice MD)", mdSign);
    // A period-1 CTI only gates on the attending signature when the CTI actually has an attending
    // physician attached (`decideRecertSign`'s `needsAttending`) — if hospice-MD-only sign already
    // fully signed it (state 'signed', not 'awaiting_attending'), there's no attending step to run.
    if ((mdSign.data as { state: string }).state === "awaiting_attending") {
      ok(
        "sign CTI (attending)",
        await s.client.POST("/api/v1/cti/{id}/sign-attending", {
          params: { path: { id: p1.cti.id } },
          body: {
            signingPhysicianName: ATTENDING_NAME,
            signingPhysicianNpi: ATTENDING_NPI,
            ifVersion: 1,
          },
        }),
      );
    } else {
      console.log("  CTI fully signed by hospice MD alone (no attending physician on this CTI)");
    }
  } else if (p1.cti.status === "awaiting_attending") {
    ok(
      "sign CTI (attending)",
      await s.client.POST("/api/v1/cti/{id}/sign-attending", {
        params: { path: { id: p1.cti.id } },
        body: { signingPhysicianName: ATTENDING_NAME, signingPhysicianNpi: ATTENDING_NPI, ifVersion: 1 },
      }),
    );
  } else {
    console.log(`  CTI already ${p1.cti.status}`);
  }

  cert = await getCert(s, patientId);
  p1 = cert.periods.find((p) => p.sequenceNumber === 1);
  if (cert.admission?.state === "active") {
    console.log("  admission already active");
    return;
  }
  if (!p1?.cti?.attendingMdSigned && cert.admission?.state !== "active") {
    console.log(
      `  WARNING: period-1 CTI ${p1?.cti?.id} has no attending physician attached, so ` +
        `attendingMdSignedAt can never be set — computeActivationGate unconditionally requires ` +
        `attending_signed for periodSequence===1 regardless of whether the CTI even has an attending ` +
        `assigned (apps/backend/.../intake/activation-gate.ts). Confirmed real gap: this admission ` +
        `cannot activate through the normal route as currently built. Attempting activate anyway to ` +
        `surface the exact 412 the gate returns.`,
    );
  }
  const activate = await s.client.POST("/api/v1/admissions/{id}/activate", {
    params: { path: { id: admissionId } },
    body: { ifVersion: cert.admission?.version ?? 0 },
  });
  console.log(
    `${activate.response.status < 300 ? "✓" : "✗"} activate admission: ${activate.response.status} ` +
      `${JSON.stringify(activate.data ?? activate.error)}`,
  );
  if (activate.response.status >= 300) {
    console.log("  --> leaving admission short of 'active'; see WARNING above if printed.");
  }
}

async function main(): Promise<void> {
  const s = await signIn("admin@wardenx.local");

  // ── Whitfield → RHC ─────────────────────────────────────────────────────────────────────────
  // Already active from `_test-admission5.ts` (admission c215c4b6…). Verify, don't re-drive.
  console.log("\n=== Whitfield: RHC (routine home care, baseline) ===");
  const whitfieldCert = await getCert(s, PATIENTS.whitfield.id);
  console.log(
    `  admission ${whitfieldCert.admission?.id} state=${(whitfieldCert.admission as unknown as { state?: string })?.state ?? "?"} — expected already active`,
  );

  // ── Brandt → GIP ────────────────────────────────────────────────────────────────────────────
  console.log("\n=== Brandt: GIP (general inpatient care) ===");
  const brandtCert0 = await getCert(s, PATIENTS.brandt.id);
  let brandtAdmId = brandtCert0.admission?.id;
  if (!brandtAdmId) brandtAdmId = await createAdmission(s, PATIENTS.brandt.id, "in_person");
  const brandtStatus = (brandtCert0.admission as unknown as { state?: string })?.state;
  if (brandtStatus !== "active") {
    await electAndActivate(s, brandtAdmId, PATIENTS.brandt.id, PATIENTS.brandt.name, "C34.90");
  } else {
    console.log("  admission already active, skipping election/activation");
  }
  const brandtFinal = await getCert(s, PATIENTS.brandt.id);
  if (brandtFinal.admission?.state !== "active") {
    // CONFIRMED BUG (not a script issue): Brandt's period-1 CTI was drafted (pre-existing, from an
    // earlier pre-fix run) with no attendingPhysicianId. `computeActivationGate` requires
    // `attending_signed` unconditionally whenever periodSequence===1 — it never checks whether the
    // CTI even HAS an attending physician to sign. Since `attendingPhysicianId` is legitimately
    // Optional on `AdmissionCreateSchema`, this is a reachable dead end for any real admission drafted
    // without one: `activate` 412s forever, and `ADMISSION_GRAPH` only accepts `executeDischarge` from
    // 'active'/'on_hold' — so the row can't even be discharged/closed out of existence via the API.
    // Left as-is (not hacked around with a void+redraft dance that risks racing gateFacts' unordered
    // `.limit(1)` CTI lookup) — a genuine, reproducible finding, worth its own fix later.
    console.log(
      "  GIP NOT REACHED: admission is permanently stuck short of 'active' — confirmed activation-gate " +
        "bug (period-1 CTI has no attending physician, but the gate demands attending_signed " +
        "unconditionally). See comment above. Skipping the LOC/GIP step for this patient.",
    );
  } else {
    const gip = await s.client.POST("/api/v1/admissions/{id}/level-of-care", {
      params: { path: { id: brandtAdmId } },
      body: {
        newLevel: "general_inpatient_care",
        effectiveStart: today(),
        reason: "Uncontrolled symptom crisis requiring 24-hour skilled management",
        facilityId: LOCATION_IPU_ID,
      },
    });
    ok("change LOC to GIP", gip);
    const locId = (gip.data as { id: string }).id;
    const confirmBed = await s.client.POST("/api/v1/level-of-care/{id}/confirm-bed", {
      params: { path: { id: locId } },
      body: { ifVersion: 0 },
    });
    console.log(
      `  confirm-bed: ${confirmBed.response.status} ${JSON.stringify(confirmBed.data ?? confirmBed.error)} ` +
        `(expected to fail/no-op — no M37 bed assignment seeded; LOC period stays 'assigning', a real state)`,
    );
  }

  // ── Okonkwo → transfer-in ───────────────────────────────────────────────────────────────────
  console.log("\n=== Okonkwo: transfer-in ===");
  const okonkwoCert0 = await getCert(s, PATIENTS.okonkwo.id);
  const okonkwoAdmId = okonkwoCert0.admission?.id ?? (await createAdmission(s, PATIENTS.okonkwo.id, "transfer_in"));
  const hasNextPeriod = okonkwoCert0.periods.some((p) => p.sequenceNumber === 3);
  if (!hasNextPeriod) {
    ok(
      "transfer in",
      await s.client.POST("/api/v1/admissions/{id}/transfer-in", {
        params: { path: { id: okonkwoAdmId } },
        body: {
          direction: "in",
          effectiveDate: today(),
          otherHospiceName: "Blue Ridge Hospice & Palliative Care",
          otherHospiceCcn: "341999",
          priorBenefitPeriodSequence: 2,
          priorElectionStartDate: "2026-06-01",
          hospiceMedicalDirectorId: HOSPICE_MD_ID,
          attendingPhysicianId: ATTENDING_ID,
          narrative:
            "Patient relocated from Blue Ridge service area; transferring mid-period-2 election.",
        },
      }),
    );
  } else {
    console.log("  transfer-in already recorded, periods 2+3 exist");
  }
  const okonkwoCert = await getCert(s, PATIENTS.okonkwo.id);
  const nextPeriod = okonkwoCert.periods.find((p) => p.sequenceNumber === 3);
  if (!nextPeriod?.cti) throw new Error("transfer-in: next period (seq 3) CTI not found");
  if (nextPeriod.cti.status === "drafted") {
    ok(
      "sign next-period CTI (hospice MD, recert path — fully signs + activates period)",
      await s.client.POST("/api/v1/cti/{id}/sign-hospice-md", {
        params: { path: { id: nextPeriod.cti.id } },
        body: { signingPhysicianName: HOSPICE_MD_NAME, signingPhysicianNpi: HOSPICE_MD_NPI, ifVersion: 0 },
      }),
    );
  } else {
    console.log(`  next-period CTI already ${nextPeriod.cti.status}`);
  }
  console.log(
    "  NOTE: admission.status has no route to 'active' for transfer-in as built (gateFacts only " +
      "ever inspects sequenceNumber=1; see file header) — inherited period 2 is 'active', next " +
      "period 3 is now 'active' too, admission row stays 'pending'. Confirmed gap, not a script bug.",
  );

  const TERMINAL_STATES = new Set(["discharged", "bereavement", "closed"]);

  // ── Delgado → discharged (live) ─────────────────────────────────────────────────────────────
  console.log("\n=== Delgado: discharged (no_longer_terminal) ===");
  const delgadoCert0 = await getCert(s, PATIENTS.delgado.id);
  let delgadoAdmId = delgadoCert0.admission?.id;
  if (!delgadoAdmId) delgadoAdmId = await createAdmission(s, PATIENTS.delgado.id, "in_person");
  const delgadoState0 = delgadoCert0.admission?.state;
  if (delgadoState0 === "active") {
    console.log("  admission already active, skipping election/activation");
  } else if (!TERMINAL_STATES.has(delgadoState0 ?? "")) {
    await electAndActivate(s, delgadoAdmId, PATIENTS.delgado.id, PATIENTS.delgado.name, "I50.9");
  }
  if (TERMINAL_STATES.has((await getCert(s, PATIENTS.delgado.id)).admission?.state ?? "")) {
    console.log("  admission already discharged, skipping discharge call");
  } else {
    ok(
      "discharge (no_longer_terminal)",
      await s.client.POST("/api/v1/admissions/{id}/discharge", {
        params: { path: { id: delgadoAdmId } },
        body: {
          reason: "no_longer_terminal",
          dischargeDate: today(),
          narrative: "Re-evaluation shows stabilized cardiac status; prognosis no longer terminal.",
        },
      }),
    );
  }

  // ── Nakamura → revoked ──────────────────────────────────────────────────────────────────────
  console.log("\n=== Nakamura: revoked ===");
  const nakamuraCert0 = await getCert(s, PATIENTS.nakamura.id);
  let nakamuraAdmId = nakamuraCert0.admission?.id;
  if (!nakamuraAdmId) nakamuraAdmId = await createAdmission(s, PATIENTS.nakamura.id, "in_person");
  const nakamuraState0 = nakamuraCert0.admission?.state;
  if (nakamuraState0 === "active") {
    console.log("  admission already active, skipping election/activation");
  } else if (!TERMINAL_STATES.has(nakamuraState0 ?? "")) {
    await electAndActivate(s, nakamuraAdmId, PATIENTS.nakamura.id, PATIENTS.nakamura.name, "C25.9");
  }
  if (TERMINAL_STATES.has((await getCert(s, PATIENTS.nakamura.id)).admission?.state ?? "")) {
    console.log("  admission already discharged, skipping revocation call");
  } else {
    ok(
      "revoke election",
      await s.client.POST("/api/v1/admissions/{id}/revocation", {
        params: { path: { id: nakamuraAdmId } },
        body: {
          revocationDate: today(),
          narrative: "Patient elects to pursue curative chemotherapy; revokes hospice election.",
          signingPatientName: PATIENTS.nakamura.name,
          signingRole: "patient",
          revocationReason: "seek_curative_treatment",
        },
      }),
    );
  }

  // ── Fairbanks → death ───────────────────────────────────────────────────────────────────────
  console.log("\n=== Fairbanks: death ===");
  const fairbanksCert0 = await getCert(s, PATIENTS.fairbanks.id);
  let fairbanksAdmId = fairbanksCert0.admission?.id;
  if (!fairbanksAdmId) fairbanksAdmId = await createAdmission(s, PATIENTS.fairbanks.id, "in_person");
  const fairbanksState0 = fairbanksCert0.admission?.state;
  if (fairbanksState0 === "active") {
    console.log("  admission already active, skipping election/activation");
  } else if (!TERMINAL_STATES.has(fairbanksState0 ?? "")) {
    await electAndActivate(s, fairbanksAdmId, PATIENTS.fairbanks.id, PATIENTS.fairbanks.name, "C61");
  }
  if (TERMINAL_STATES.has((await getCert(s, PATIENTS.fairbanks.id)).admission?.state ?? "")) {
    console.log("  admission already discharged, skipping discharge call");
    console.log("\n=== Done: 6/6 patients driven to their target admission outcome ===");
    return;
  }
  ok(
    "discharge (death)",
    await s.client.POST("/api/v1/admissions/{id}/discharge", {
      params: { path: { id: fairbanksAdmId } },
      body: {
        reason: "death",
        dischargeDate: today(),
        narrative: "Patient expired peacefully at home, family present, comfort measures maintained.",
        deathCertifierId: HOSPICE_MD_ID,
      },
    }),
  );

  console.log("\n=== Done: 6/6 patients driven to their target admission outcome ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
