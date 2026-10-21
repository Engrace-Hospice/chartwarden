// apps/backend/__tests__/billing-eraser.test.ts — M23-T79 the `billing_record` destruction-cert eraser
// (§3.7 / §8.4). Subject under test: apps/backend/src/modules/23-billing-medicare/erasers/billing-eraser.ts
// — the backend adapter that bridges the pure `@chartwarden/billing` `BillingEraseStore` contract to the M1
// `DataEraser` and registers it over the Phase-0 deny-stub via the injected `registerEraser` hook.
//
// PLACEMENT NOTE: the eraser-cascade test lives here (apps/backend/__tests__) rather than
// packages/billing/__tests__ because its subject is the BACKEND adapter + the M4 destruction-registry
// registration path (registry import + createBillingEraser + registerBillingErasers) — a package test
// cannot import apps/backend. This mirrors every sibling *-eraser.test.ts (care-plan, patient, orders…).
// The PURE §3.7 contract it drives (M23_PATIENT_CASCADE_ORDER / M23_REDACT_FIELDS / BillingEraseRefused)
// is asserted directly against the `@chartwarden/billing` exports.
//
// Unlike M27/M30 (org-only operational rows), the M23 billing record IS per-patient PHI and is
// COMPLIANCE-class (7 years past final action, M4 D1) — so the registered eraser is the DESTRUCTION
// handler the M4 destruction-cert workflow invokes, NOT an ordinary-offboarding cleanup. These suites
// drive it with a SYNTHETIC long-stay patient (30 claims + lines + submissions + acks + validation
// runs/results/overrides + perDiemClass/sia + noe/notr + eligibility) through an in-memory recording store double
// (the M33 reporting `eraser.test.ts` template — a `calls[]` trail + a recording fake), and prove the §3.7
// destruction invariants:
//   • the cascade walks M23_PATIENT_CASCADE_ORDER children-first so FKs unwind cleanly;
//   • the 7-year compliance-class billing record is destruction-GATED — an in-flight claim / surveyor hold
//     RAISES `BillingEraseRefused` (fail-closed, never a silent no-op), and only proceeds when the
//     destruction certificate authorizes it;
//   • the MAC `client_secret_cipher` is cryptographically SHREDDED (zero-filled + DEK rotated) and the
//     §3.7 free-text PHI fields are REDACTED (not orphaned) — the org-destruction path;
//   • the destruction certificate records the affected-row count PER TABLE, summed into `{ erased }`.
import {
  BillingEraseRefused,
  type BillingEraseStore,
  type BillingEraseTableCounts,
  M23_PATIENT_CASCADE_ORDER,
  M23_REDACT_FIELDS,
  M23_RETENTION_CLASS,
} from "@chartwarden/billing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetErasersForTest,
  getEraser,
  registerEraser,
} from "../src/bootstrap/erasers/registry";
import {
  BILLING_DATA_CLASS,
  createBillingEraser,
  registerBillingErasers,
} from "../src/modules/23-billing-medicare/index";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const PATIENT = "11111111-1111-1111-1111-1111111111bb";

/**
 * The synthetic LONG-STAY patient: per-table row counts keyed by the §3.7 cascade table. A multi-year
 * hospice stay accretes ~30 monthly claims (one per benefit-period month), each with lines / HIPPS / SIA
 * calcs / submissions / acks / validation chains, plus the one-time NOE + (final) NOTR and the recurring
 * eligibility checks. Numbers are representative, not CMS fixtures (no per-diem arithmetic here).
 */
const LONG_STAY_SEED: BillingEraseTableCounts = {
  eligibility_check: 30,
  // ADR-0052 migration 1060 — the DDE work queue (two items, three history rows each).
  dde_work_event: 6,
  dde_work_item: 2,
  claim_acknowledgment: 55,
  claim_submission: 42,
  claim_state_history: 180,
  validation_override: 7,
  validation_result: 96,
  validation_run: 48,
  sia_calculation: 12,
  per_diem_rate_calculation: 30,
  claim_line: 120,
  claim: 30,
  noe_record: 1,
  notr_record: 1,
  // Migration 0375 — the 8xC transfer notice (an original + its accepted correction).
  transfer_notice_record: 2,
};

/** A MAC credential whose secret cipher must be cryptographically shredded at org-destruction. */
interface MacCredentialRow {
  client_secret_cipher: string;
  dekId: string;
}

interface RecordingStore {
  store: BillingEraseStore;
  /** The ordered cascade trail — one entry per table touched by erasePatientBillingRecord. */
  cascadeTrail: string[];
  /** The free-text fields redacted (NOT dropped) during the per-patient cascade. */
  redactedPatientFields: string[];
  /** The free-text fields redacted during org-destruction. */
  redactedOrgFields: string[];
  /** The MAC credential row, mutated in place by the cryptographic shred. */
  macCredential: MacCredentialRow;
}

/**
 * Build the in-memory recording `BillingEraseStore` double (the prod Drizzle store is P3-injected). It
 * encodes the §3.7 semantics the Drizzle store must honour: walk M23_PATIENT_CASCADE_ORDER children-first,
 * redact (not orphan) the per-table free-text fields, refuse an in-flight / surveyor-held record unless the
 * destruction certificate authorizes it, and crypto-shred the MAC secret at org-destruction.
 */
function makeRecordingStore(opts?: {
  seed?: BillingEraseTableCounts;
  inFlight?: boolean;
  surveyorHold?: boolean;
  destructionCertAuthorized?: boolean;
}): RecordingStore {
  const seed = opts?.seed ?? LONG_STAY_SEED;
  const cascadeTrail: string[] = [];
  const redactedPatientFields: string[] = [];
  const redactedOrgFields: string[] = [];
  const macCredential: MacCredentialRow = {
    client_secret_cipher: "ENC::v1::mac-edi-shared-secret",
    dekId: "tenant-dek-v1",
  };

  const patientTables = new Set<string>(M23_PATIENT_CASCADE_ORDER);

  const store: BillingEraseStore = {
    async erasePatientBillingRecord({ organizationId, patientId }) {
      // §3.7 in-flight / surveyor-hold GATE — fail-closed. The compliance-class billing record is NOT
      // silently dropped: a claim still moving through submission / awaiting a MAC ack, or a record under a
      // surveyor hold, REFUSES the erase (propagates to the M4 destruction-cert workflow) unless the
      // certificate explicitly authorizes destruction.
      if ((opts?.inFlight || opts?.surveyorHold) && !opts?.destructionCertAuthorized) {
        throw new BillingEraseRefused(opts?.inFlight ? "claim_in_flight" : "surveyor_hold");
      }
      // Tenancy: every delete/redact is scoped to org + patient.
      expect(organizationId).toBe(ORG);
      const counts: BillingEraseTableCounts = {};
      for (const table of M23_PATIENT_CASCADE_ORDER) {
        cascadeTrail.push(table);
        counts[table] = seed[table] ?? 0;
        // Redact (not orphan) the per-table free-text PHI fields the cascade passes through.
        for (const field of M23_REDACT_FIELDS) {
          if (field.startsWith(`${table}.`) && patientTables.has(field.split(".")[0]!)) {
            redactedPatientFields.push(`${field}#${patientId}`);
          }
        }
      }
      return counts;
    },

    async eraseOrgBillingConfig({ organizationId }) {
      expect(organizationId).toBe(ORG);
      // Cryptographic SHRED of the MAC EDI credential: zero-fill the ciphertext + rotate/destroy the DEK so
      // the shared secret is unrecoverable (NOT a row delete — the credential row's structural shell may
      // survive for FK integrity, but its secret is gone).
      macCredential.client_secret_cipher = "";
      macCredential.dekId = "SHREDDED";
      // Redact org-scoped free-text (sequestration set-reason) — fields NOT in the per-patient cascade.
      for (const field of M23_REDACT_FIELDS) {
        if (!patientTables.has(field.split(".")[0]!)) redactedOrgFields.push(field);
      }
      return { mac_submitter_credential: 1, sequestration_policy: 1, validation_rule_config: 4 };
    },
  };

  return { store, cascadeTrail, redactedPatientFields, redactedOrgFields, macCredential };
}

describe("M23-T79 — billing_record §3.7 cascade order (children-first FK unwind)", () => {
  it("the package cascade constant orders every child before its parent (FK-safe)", () => {
    const idx = (t: string) => M23_PATIENT_CASCADE_ORDER.indexOf(t as never);
    // ack references submission → ack first.
    expect(idx("claim_acknowledgment")).toBeLessThan(idx("claim_submission"));
    // validation override → result → run (most-child first).
    expect(idx("validation_override")).toBeLessThan(idx("validation_result"));
    expect(idx("validation_result")).toBeLessThan(idx("validation_run"));
    // every claim child precedes the claim row itself.
    for (const child of [
      "claim_line",
      "per_diem_rate_calculation",
      "sia_calculation",
      "claim_state_history",
    ]) {
      expect(idx(child)).toBeLessThan(idx("claim"));
    }
    // noe_record / notr_record / transfer_notice_record are the independent notice entities — deleted LAST.
    expect(idx("noe_record")).toBe(M23_PATIENT_CASCADE_ORDER.length - 3);
    expect(idx("notr_record")).toBe(M23_PATIENT_CASCADE_ORDER.length - 2);
    expect(idx("transfer_notice_record")).toBe(M23_PATIENT_CASCADE_ORDER.length - 1);
    // eligibility_check is the leaf-most child — deleted FIRST.
    expect(idx("eligibility_check")).toBe(0);
  });

  it("the cascade walks M23_PATIENT_CASCADE_ORDER exactly, in order, for the long-stay patient", async () => {
    const { store, cascadeTrail } = makeRecordingStore();
    await createBillingEraser(store).erase({ orgId: ORG }, PATIENT);
    expect(cascadeTrail).toEqual([...M23_PATIENT_CASCADE_ORDER]);
  });

  it("NO MBI is ever an eraser field — it never persists (§3.6)", () => {
    for (const table of M23_PATIENT_CASCADE_ORDER) expect(table).not.toMatch(/mbi/i);
    for (const field of M23_REDACT_FIELDS) expect(field).not.toMatch(/\bmbi\b/i);
  });
});

describe("M23-T79 — the destruction certificate records affected-row counts per table", () => {
  it("returns the per-table count for every cascade table (the M4 cert `tableCounts`)", async () => {
    const counts = await makeRecordingStore().store.erasePatientBillingRecord({
      organizationId: ORG,
      patientId: PATIENT,
    });
    for (const table of M23_PATIENT_CASCADE_ORDER) {
      expect(counts[table]).toBe(LONG_STAY_SEED[table]);
    }
    expect(counts.claim).toBe(30);
    expect(counts.claim_line).toBe(120);
    expect(counts.claim_state_history).toBe(180);
  });

  it("the adapter sums every per-table count into { erased } (no double-count, no omission)", async () => {
    const { store } = makeRecordingStore();
    const { erased } = await createBillingEraser(store).erase({ orgId: ORG }, PATIENT);
    const expected = Object.values(LONG_STAY_SEED).reduce((a, b) => a + b, 0);
    expect(expected).toBe(662); // 30+6+2+55+42+180+7+96+48+12+30+120+30+1+1+2
    expect(erased).toBe(662);
  });

  it("an unseeded patient erases nothing (the cascade still runs, all counts 0)", async () => {
    const { store, cascadeTrail } = makeRecordingStore({ seed: {} });
    const { erased } = await createBillingEraser(store).erase({ orgId: ORG }, PATIENT);
    expect(erased).toBe(0);
    expect(cascadeTrail).toEqual([...M23_PATIENT_CASCADE_ORDER]); // still walks every table
  });
});

describe("M23-T79 — the 7-year compliance-class record is destruction-GATED (never a silent drop)", () => {
  it("REFUSES an erase of an in-flight claim (BillingEraseRefused, fail-closed)", async () => {
    const { store, cascadeTrail } = makeRecordingStore({ inFlight: true });
    await expect(createBillingEraser(store).erase({ orgId: ORG }, PATIENT)).rejects.toBeInstanceOf(
      BillingEraseRefused,
    );
    await expect(createBillingEraser(store).erase({ orgId: ORG }, PATIENT)).rejects.toThrow(
      /claim_in_flight/,
    );
    // fail-closed: NOTHING was cascaded (no partial destruction of a still-active claim).
    expect(cascadeTrail).toEqual([]);
  });

  it("REFUSES an erase of a record under a surveyor hold", async () => {
    const { store } = makeRecordingStore({ surveyorHold: true });
    await expect(createBillingEraser(store).erase({ orgId: ORG }, PATIENT)).rejects.toThrow(
      /surveyor_hold/,
    );
  });

  it("PROCEEDS once the destruction certificate authorizes destroying the held record", async () => {
    const { store, cascadeTrail } = makeRecordingStore({
      inFlight: true,
      destructionCertAuthorized: true,
    });
    const { erased } = await createBillingEraser(store).erase({ orgId: ORG }, PATIENT);
    expect(erased).toBe(662);
    expect(cascadeTrail).toEqual([...M23_PATIENT_CASCADE_ORDER]);
  });

  it("the refusal propagates through the M4-registered eraser boundary (not swallowed)", async () => {
    __resetErasersForTest();
    registerBillingErasers({
      registerEraser,
      store: makeRecordingStore({ surveyorHold: true }).store,
    });
    await expect(
      getEraser(BILLING_DATA_CLASS).erase({ orgId: ORG }, PATIENT),
    ).rejects.toBeInstanceOf(BillingEraseRefused);
  });
});

describe("M23-T79 — cryptographic shred + free-text redaction (org-destruction path)", () => {
  it("zero-fills mac_submitter_credential.client_secret_cipher and rotates/destroys the DEK", async () => {
    const rec = makeRecordingStore();
    expect(rec.macCredential.client_secret_cipher).not.toBe(""); // seeded with a real cipher
    await rec.store.eraseOrgBillingConfig({ organizationId: ORG });
    expect(rec.macCredential.client_secret_cipher).toBe(""); // zero-filled — unrecoverable
    expect(rec.macCredential.dekId).toBe("SHREDDED"); // DEK rotated/destroyed
    // the cipher field IS in the redact-surface contract (a crypto-shred, not a plain delete).
    expect(M23_REDACT_FIELDS).toContain("mac_submitter_credential.client_secret_cipher");
  });

  it("redacts (does NOT orphan) the per-patient free-text PHI fields during the cascade", async () => {
    const { store, redactedPatientFields } = makeRecordingStore();
    await store.erasePatientBillingRecord({ organizationId: ORG, patientId: PATIENT });
    // every per-patient redact field in the §3.7 contract is redacted (tagged with the subject).
    const patientRedactTargets = M23_REDACT_FIELDS.filter((f) =>
      (M23_PATIENT_CASCADE_ORDER as readonly string[]).includes(f.split(".")[0]!),
    );
    expect(patientRedactTargets.length).toBeGreaterThan(0);
    for (const field of patientRedactTargets) {
      expect(redactedPatientFields).toContain(`${field}#${PATIENT}`);
    }
    // sanity: the claim replacement-reason + override reason + the patient_id_ref columns are covered.
    expect(redactedPatientFields).toContain(`claim.replacement_reason#${PATIENT}`);
    expect(redactedPatientFields).toContain(`validation_override.reason#${PATIENT}`);
    expect(redactedPatientFields).toContain(`eligibility_check.patient_id_ref#${PATIENT}`);
  });

  it("the per-patient cascade NEVER touches the MAC credential (org-destruction concern only)", async () => {
    const rec = makeRecordingStore();
    await rec.store.erasePatientBillingRecord({ organizationId: ORG, patientId: PATIENT });
    // the per-patient subject path leaves the org credential cipher intact — shred is the org path.
    expect(rec.macCredential.client_secret_cipher).not.toBe("");
    expect(rec.cascadeTrail).not.toContain("mac_submitter_credential");
  });
});

describe("M23-T79 — M4 destruction-registry registration over the deny-stub", () => {
  beforeEach(() => __resetErasersForTest());

  it("registers under the `billing_record` retention class via the INJECTED registerEraser hook", async () => {
    expect(BILLING_DATA_CLASS).toBe(M23_RETENTION_CLASS);
    let boundClass: string | undefined;
    registerBillingErasers({
      registerEraser: (dataClass, eraser) => {
        boundClass = dataClass;
        registerEraser(dataClass, eraser);
      },
      store: makeRecordingStore().store,
    });
    expect(boundClass).toBe("billing_record");
    const { erased } = await getEraser(BILLING_DATA_CLASS).erase({ orgId: ORG }, PATIENT);
    expect(erased).toBe(662);
  });

  it("the default (no store injected) registers a non-throwing no-op eraser (slice store)", async () => {
    registerBillingErasers({ registerEraser });
    const { erased } = await getEraser(BILLING_DATA_CLASS).erase({ orgId: ORG }, PATIENT);
    expect(erased).toBe(0); // in-memory slice store deletes nothing until the Drizzle store binds
  });
});
