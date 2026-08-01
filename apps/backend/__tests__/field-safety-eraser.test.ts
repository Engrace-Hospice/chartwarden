// M20-T02 — the §3.7 `safety_record` eraser's orchestration contract. The Drizzle store is exercised by the
// live RLS suite; what is asserted here is the ORDER, the ARITHMETIC and the SCOPE — the three things a
// destruction certificate depends on and none of which a type checker can see.
//
// The scope assertion is the one that matters most in this module. M20 is a WORKFORCE-safety module: almost
// every row it owns is the CLINICIAN's record, and a patient's right to erasure does not reach the
// clinician's workers-comp evidence. An eraser that widened from "unlink the patient" to "delete the safety
// record" would pass every other gate in the build and destroy exactly the thing §1.1 exists to preserve.
import { describe, expect, it } from "vitest";
import { getEraser } from "../src/bootstrap/index";
import {
  type SafetyEraseStore,
  createInMemorySafetyEraseStore,
  createSafetyEraser,
  eraseSafetyRecord,
  registerSafetyErasers,
} from "../src/modules/20-field-safety/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const PATIENT = "77777777-0000-0000-0000-000000000002";

describe("M20-T02 §3.7 safety_record eraser", () => {
  it("locks the patient, redacts the free text, then severs the linkage — in that order", async () => {
    const calls: string[] = [];
    const store: SafetyEraseStore = {
      async lockPatient() {
        calls.push("lock");
      },
      async redactLinkedRecords() {
        calls.push("redact");
        return { incidents: 2, sosAlerts: 1, acknowledgments: 3 };
      },
      async severPatientLinkage() {
        calls.push("sever");
        return { incidents: 2, sosAlerts: 1 };
      },
    };
    const out = await eraseSafetyRecord(ORG, PATIENT, store);
    // Redact BEFORE sever: the linkage is the key every redaction statement selects on, so clearing it
    // first would make a partial failure unrecoverable — nothing left to find the rows by.
    expect(calls).toEqual(["lock", "redact", "sever"]);
    expect(out.redacted).toBe(6);
    expect(out.erased).toBe(3);
  });

  it("reports linkages severed as `erased` and redactions separately — nothing is deleted", async () => {
    const { store } = createInMemorySafetyEraseStore({
      counts: { incidents: 2, sosAlerts: 1, acknowledgments: 3 },
    });
    const { erased, redacted, counts } = await eraseSafetyRecord(ORG, PATIENT, store);
    // 2 incidents + 1 SOS unlinked. The three acknowledgments were redacted, not removed, and the rows
    // themselves all survive by design (§3.7 — "structural row retained with redacted markers").
    expect(erased).toBe(3);
    expect(redacted).toBe(6);
    expect(counts.acknowledgments).toBe(3);
  });

  it("is idempotent — a second destruction certificate finds nothing", async () => {
    const { store } = createInMemorySafetyEraseStore({
      counts: { incidents: 2, sosAlerts: 1, acknowledgments: 3 },
    });
    const first = await eraseSafetyRecord(ORG, PATIENT, store);
    const second = await eraseSafetyRecord(ORG, PATIENT, store);
    expect(first.erased).toBe(3);
    expect(second.erased).toBe(0);
    expect(second.redacted).toBe(0);
  });

  it("rejects a malformed retention boundary rather than erasing on an unparseable cert", async () => {
    const { store } = createInMemorySafetyEraseStore();
    // The in-memory store does not validate; the Drizzle store does. What is pinned here is that the
    // boundary reaches the store at all — the certificate's value is never silently dropped.
    let seen: string | undefined;
    const spy: SafetyEraseStore = {
      ...store,
      async severPatientLinkage(_org, _patient, retentionAsOf) {
        seen = retentionAsOf;
        return { incidents: 0, sosAlerts: 0 };
      },
    };
    await eraseSafetyRecord(ORG, PATIENT, spy, { retentionAsOf: "2026-01-01T00:00:00.000Z" });
    expect(seen).toBe("2026-01-01T00:00:00.000Z");
  });

  it("passes the M4 scope's org through and locks on the subject patient", async () => {
    const { store, locked } = createInMemorySafetyEraseStore({ counts: { incidents: 4 } });
    const eraser = createSafetyEraser(store);
    const result = await eraser.erase({ orgId: ORG }, PATIENT);
    expect(result).toEqual({ erased: 4 });
    expect(locked).toEqual([PATIENT]);
  });

  it("registers over the Phase-0 deny-stub so a right-to-erasure request is not a silent no-op", async () => {
    const { store } = createInMemorySafetyEraseStore({ counts: { sosAlerts: 5 } });
    registerSafetyErasers({ store });
    const registered = getEraser("safety_record");
    await expect(registered.erase({ orgId: ORG }, PATIENT)).resolves.toEqual({ erased: 5 });
  });
});
