// M19-T02 — the §3.7 `triage_record` eraser's orchestration contract. The Drizzle store is exercised by
// the live RLS suite; what is asserted here is the ORDER and the ARITHMETIC, both of which are the parts a
// destruction certificate depends on and neither of which a type checker can see.
import {
  createInMemoryTriageEraseStore,
  createTriageEraser,
  eraseTriageRecord,
  registerTriageErasers,
  type TriageEraseStore,
} from "../src/modules/19-oncall/index";
import { getEraser } from "../src/bootstrap/index";
import { describe, expect, it } from "vitest";

const ORG = "11111111-1111-1111-1111-111111111111";
const PATIENT = "77777777-0000-0000-0000-000000000001";

describe("M19-T02 §3.7 triage_record eraser", () => {
  it("locks the patient, shreds the PHI columns, then deletes — in that order", async () => {
    const calls: string[] = [];
    const store: TriageEraseStore = {
      async lockPatient() {
        calls.push("lock");
      },
      async shredCallColumns() {
        calls.push("shred");
        return 2;
      },
      async erasePatientRecords() {
        calls.push("erase");
        return { escalations: 1, answers: 4, stateHistory: 6, callsTombstoned: 2 };
      },
    };
    const out = await eraseTriageRecord(ORG, PATIENT, store);
    // Shred BEFORE delete: a failure halfway leaves the caller's words unreadable rather than intact.
    expect(calls).toEqual(["lock", "shred", "erase"]);
    expect(out.shredded).toBe(2);
    expect(out.counts.callsTombstoned).toBe(2);
  });

  it("counts only DELETED rows — the tombstoned calls are not erasure", async () => {
    const { store } = createInMemoryTriageEraseStore({
      counts: { escalations: 1, answers: 4, stateHistory: 6, callsTombstoned: 2 },
      shredded: 2,
    });
    const { erased } = await eraseTriageRecord(ORG, PATIENT, store);
    // 1 + 4 + 6 — NOT 13. The two `triage_call` rows survive de-identified because M8's signed
    // triage_telephonic_contact encounter back-references them (§3.7).
    expect(erased).toBe(11);
  });

  it("is idempotent — a second destruction certificate finds nothing", async () => {
    const { store } = createInMemoryTriageEraseStore({
      counts: { escalations: 1, answers: 4, stateHistory: 6, callsTombstoned: 2 },
      shredded: 2,
    });
    const first = await eraseTriageRecord(ORG, PATIENT, store);
    const second = await eraseTriageRecord(ORG, PATIENT, store);
    expect(first.erased).toBe(11);
    expect(second.erased).toBe(0);
    expect(second.shredded).toBe(0);
  });

  it("passes the M4 scope's org through and locks on the subject patient", async () => {
    const { store, locked } = createInMemoryTriageEraseStore({ counts: { answers: 3 } });
    const eraser = createTriageEraser(store);
    const result = await eraser.erase({ orgId: ORG }, PATIENT);
    expect(result).toEqual({ erased: 3 });
    expect(locked).toEqual([PATIENT]);
  });

  it("registers over the Phase-0 deny-stub so a right-to-erasure request is not a silent no-op", async () => {
    const { store } = createInMemoryTriageEraseStore({ counts: { stateHistory: 5 } });
    registerTriageErasers({ store });
    const registered = getEraser("triage_record");
    await expect(registered.erase({ orgId: ORG }, PATIENT)).resolves.toEqual({ erased: 5 });
  });
});
